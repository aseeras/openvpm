import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { readJsonRequestBody } from "@/lib/request-json";
import { clientIpFromRequest } from "@/lib/request-ip";
import { isSameOriginRequest } from "@/lib/request-origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  APPLE_IDENTITY_TOKEN_MAX_LENGTH,
  APPLE_NONCE_COOKIE,
  appleSignInClientIds,
  AppleTokenError,
  verifyAppleIdentityToken,
} from "@/lib/portal/apple-sign-in";
import { signInWithProviderIdentity } from "@/lib/portal/identity-sign-in";
import { linkProviderIdentity } from "@/lib/portal/identity-link";
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
  portalSessionTokenFromCookie,
  resolvePortalSession,
} from "@/lib/portal/session";

const input = z.object({
  identityToken: z.string().min(1).max(APPLE_IDENTITY_TOKEN_MAX_LENGTH),
  // "link" connects the Apple ID to the client already signed in here.
  mode: z.enum(["sign_in", "link"]).default("sign_in"),
  // From Apple's sheet on the first sign-in only; not part of the signed token.
  givenName: z.string().trim().max(128).optional(),
  familyName: z.string().trim().max(128).optional(),
});
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const PROVIDER = "apple" as const;

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  // The nonce is single use whatever the outcome.
  response.cookies.set(APPLE_NONCE_COOKIE, "", { path: "/api/portal/apple", maxAge: 0 });
  return response;
}

async function allowAttempt(ip: string): Promise<boolean> {
  try {
    const result = await rateLimit({
      key: `portal-apple:ip:${ip}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    return result.success;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return json({ error: "Invalid request origin" }, 403);
  const audiences = appleSignInClientIds();
  if (audiences.length === 0) return json({ error: "Sign in with Apple is not available" }, 404);

  const body = await readJsonRequestBody(req);
  const parsed = body.ok ? input.safeParse(body.data) : null;
  if (!parsed?.success) return json({ error: "Sign in with Apple failed. Please try again." }, 400);

  const ip = clientIpFromRequest(req);
  if (!(await allowAttempt(ip))) {
    return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  }

  const nonce = req.cookies.get(APPLE_NONCE_COOKIE)?.value;
  if (!nonce) return json({ error: "Sign in with Apple timed out. Please try again." }, 400);

  let identity;
  try {
    identity = await verifyAppleIdentityToken(parsed.data.identityToken, { audiences, nonce });
  } catch (error) {
    if (!(error instanceof AppleTokenError)) console.error("[portal-apple] verify failed");
    return json({ error: "Sign in with Apple failed. Please try again." }, 401);
  }

  const now = new Date();
  const userAgent = req.headers.get("user-agent");

  try {
    if (parsed.data.mode === "link") {
      const outcome = await withSystem(db, async (tx) => {
        const session = await resolvePortalSession(
          tx,
          portalSessionTokenFromCookie(req.headers.get("cookie")),
          now,
        );
        if (!session) return "signed_out" as const;
        return linkProviderIdentity(tx, {
          practiceId: session.client.practiceId,
          clientId: session.client.id,
          provider: PROVIDER,
          identity,
          now,
        });
      });
      if (outcome === "signed_out") {
        return json({ error: "Your session ended. Sign in again, then turn on Sign in with Apple." }, 401);
      }
      if (outcome === "taken") {
        return json({ error: "This Apple ID is already connected to another ZenPaws account." }, 409);
      }
      return json({ linked: true });
    }

    const rawSessionToken = await withSystem(db, (tx) =>
      signInWithProviderIdentity(tx, {
        provider: PROVIDER,
        identity,
        givenName: parsed.data.givenName,
        familyName: parsed.data.familyName,
        ip,
        userAgent,
        now,
      }),
    );

    if (!rawSessionToken) {
      return json(
        {
          code: "not_linked",
          error:
            "We couldn't set up an account with this Apple ID. Sign in with your username and password (or create an account), then turn on Sign in with Apple in Account.",
        },
        404,
      );
    }

    const response = json({ redirectTo: "/portal" });
    response.cookies.set(portalSessionCookieName(), rawSessionToken, portalSessionCookieOptions(now));
    return response;
  } catch {
    console.error("[portal-apple] sign-in failed");
    return json({ error: "Sign-in is temporarily unavailable. Please try again." }, 500);
  }
}
