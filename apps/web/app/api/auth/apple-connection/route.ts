import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { users } from "@openpims/db";
import { db } from "@openpims/db/client";
import { authOptions } from "@/lib/auth";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { withSystem } from "@/lib/tenant-db";
import { readJsonRequestBody } from "@/lib/request-json";
import { clientIpFromRequest } from "@/lib/request-ip";
import { isSameOriginRequest } from "@/lib/request-origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  APPLE_IDENTITY_TOKEN_MAX_LENGTH,
  AppleTokenError,
  verifyAppleIdentityToken,
} from "@/lib/portal/apple-sign-in";
import {
  connectAppleToStaff,
  disconnectAppleFromStaff,
  STAFF_APPLE_NONCE_COOKIE,
  STAFF_APPLE_NONCE_COOKIE_PATH,
  staffAppleClientIds,
} from "@/lib/staff-apple-sign-in";

/**
 * Whether Sign in with Apple is on for staff, and whether the signed-in staff
 * member has connected an Apple ID (GET); connect one (POST) or disconnect it
 * (DELETE).
 */

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const input = z.object({
  identityToken: z.string().min(1).max(APPLE_IDENTITY_TOKEN_MAX_LENGTH),
});

function json(body: unknown, status = 200, clearNonce = false) {
  const response = NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
  if (clearNonce) {
    response.cookies.set(STAFF_APPLE_NONCE_COOKIE, "", { path: STAFF_APPLE_NONCE_COOKIE_PATH, maxAge: 0 });
  }
  return response;
}

async function signedInUserId(): Promise<string | null> {
  if (hasBlankConfiguredNextAuthSecret()) return null;
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

export async function GET() {
  const available = staffAppleClientIds().length > 0;
  const userId = available ? await signedInUserId() : null;
  if (!userId) return json({ available, connected: null });
  const [me] = await withSystem(db, (tx) =>
    tx
      .select({ appleSubject: users.appleSubject })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1),
  );
  return json({ available, connected: Boolean(me?.appleSubject) });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return json({ error: "Invalid request origin" }, 403, true);
  const audiences = staffAppleClientIds();
  if (audiences.length === 0) return json({ error: "Sign in with Apple is not available" }, 404, true);

  const userId = await signedInUserId();
  if (!userId) return json({ error: "Your session ended. Sign in again, then turn on Sign in with Apple." }, 401, true);

  const body = await readJsonRequestBody(req);
  const parsed = body.ok ? input.safeParse(body.data) : null;
  if (!parsed?.success) return json({ error: "Sign in with Apple failed. Please try again." }, 400, true);

  try {
    const limit = await rateLimit({
      key: `staff-apple-connect:ip:${clientIpFromRequest(req)}`,
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    if (!limit.success) return json({ error: "Too many attempts. Please wait a few minutes." }, 429, true);
  } catch {
    return json({ error: "Please try again in a few minutes." }, 503, true);
  }

  const nonce = req.cookies.get(STAFF_APPLE_NONCE_COOKIE)?.value;
  if (!nonce) return json({ error: "Sign in with Apple timed out. Please try again." }, 400, true);

  let identity;
  try {
    identity = await verifyAppleIdentityToken(parsed.data.identityToken, { audiences, nonce });
  } catch (error) {
    if (!(error instanceof AppleTokenError)) console.error("[staff-apple] verify failed");
    return json({ error: "Sign in with Apple failed. Please try again." }, 401, true);
  }

  try {
    const outcome = await withSystem(db, (tx) => connectAppleToStaff(tx, userId, identity.subject));
    if (outcome === "signed_out") {
      return json({ error: "Your session ended. Sign in again, then turn on Sign in with Apple." }, 401, true);
    }
    if (outcome === "taken") {
      return json({ error: "This Apple ID is already connected to another staff login." }, 409, true);
    }
    return json({ connected: true }, 200, true);
  } catch {
    console.error("[staff-apple] connect failed");
    return json({ error: "Sign in with Apple is temporarily unavailable. Please try again." }, 500, true);
  }
}

export async function DELETE(req: NextRequest) {
  if (!isSameOriginRequest(req)) return json({ error: "Invalid request origin" }, 403);
  const userId = await signedInUserId();
  if (!userId) return json({ error: "Your session ended. Sign in again." }, 401);
  await withSystem(db, (tx) => disconnectAppleFromStaff(tx, userId));
  return json({ connected: false });
}
