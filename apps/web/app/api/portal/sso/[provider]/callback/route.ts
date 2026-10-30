import { NextRequest, NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { appBaseUrl } from "@/lib/app-url";
import { withSystem } from "@/lib/tenant-db";
import { clientIpFromRequest } from "@/lib/request-ip";
import { rateLimit } from "@/lib/rate-limit";
import { IdTokenError } from "@/lib/portal/id-token";
import { signInWithProviderIdentity, type SignInProvider } from "@/lib/portal/identity-sign-in";
import { portalSessionCookieName, portalSessionCookieOptions } from "@/lib/portal/session";
import {
  appleIdentityFromPost,
  decodeSsoCookie,
  googleIdentityFromCode,
  isSignInProvider,
  SSO_COOKIE,
  ssoCookieOptions,
  stateMatches,
  type ResolvedIdentity,
} from "@/lib/portal/web-sso";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function redirect(path: string) {
  const response = NextResponse.redirect(`${appBaseUrl()}${path}`, { status: 303, headers: NO_STORE_HEADERS });
  // The state is single use whatever the outcome.
  response.cookies.set(SSO_COOKIE, "", ssoCookieOptions(0));
  return response;
}

const backToSignIn = (error: string) => redirect(`/portal/account?sso_error=${error}`);

async function finish(
  req: NextRequest,
  provider: string,
  returned: { state: unknown; error: unknown },
  resolve: (nonce: string) => Promise<ResolvedIdentity>,
) {
  if (!isSignInProvider(provider)) return backToSignIn("unavailable");
  const saved = decodeSsoCookie(req.cookies.get(SSO_COOKIE)?.value);
  // Someone backing out of the provider's page is not an error worth alarming them over.
  if (typeof returned.error === "string") {
    return backToSignIn(returned.error === "user_cancelled_authorize" || returned.error === "access_denied" ? "cancelled" : "failed");
  }
  if (!stateMatches(saved, provider as SignInProvider, returned.state)) return backToSignIn("expired");

  const ip = clientIpFromRequest(req);
  try {
    const limit = await rateLimit({ key: `portal-sso:callback:${ip}`, limit: 20, windowMs: 15 * 60 * 1000 });
    if (!limit.success) return backToSignIn("busy");
  } catch {
    return backToSignIn("busy");
  }

  let identity: ResolvedIdentity;
  try {
    identity = await resolve(saved.nonce);
  } catch (error) {
    if (!(error instanceof IdTokenError)) console.error(`[portal-sso] ${provider} verify failed`);
    return backToSignIn("failed");
  }

  const now = new Date();
  try {
    const rawSessionToken = await withSystem(db, (tx) =>
      signInWithProviderIdentity(tx, {
        provider: saved.provider,
        identity,
        givenName: identity.givenName,
        familyName: identity.familyName,
        ip,
        userAgent: req.headers.get("user-agent"),
        now,
      }),
    );
    if (!rawSessionToken) return backToSignIn("not_linked");
    const response = redirect(saved.next);
    response.cookies.set(portalSessionCookieName(), rawSessionToken, portalSessionCookieOptions(now));
    return response;
  } catch {
    console.error(`[portal-sso] ${provider} sign-in failed`);
    return backToSignIn("unavailable");
  }
}

/** Apple posts its answer back (response_mode=form_post). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "apple") return backToSignIn("unavailable");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return backToSignIn("failed");
  }
  return finish(req, provider, { state: form.get("state"), error: form.get("error") }, (nonce) =>
    appleIdentityFromPost({ idToken: form.get("id_token"), user: form.get("user") }, nonce),
  );
}

/** Google redirects back with a one-time code. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "google") return backToSignIn("unavailable");
  const query = req.nextUrl.searchParams;
  return finish(req, provider, { state: query.get("state"), error: query.get("error") }, (nonce) =>
    googleIdentityFromCode(query.get("code"), nonce),
  );
}
