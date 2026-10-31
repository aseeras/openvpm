import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-url";
import { clientIpFromRequest } from "@/lib/request-ip";
import { rateLimit } from "@/lib/rate-limit";
import { portalSessionTokenFromCookie } from "@/lib/portal/session";
import {
  authorizeUrl,
  encodeSsoCookie,
  isSignInProvider,
  newSsoState,
  SSO_COOKIE,
  ssoCookieOptions,
} from "@/lib/portal/web-sso";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function backToSignIn(error: string) {
  return NextResponse.redirect(`${appBaseUrl()}/portal/account?sso_error=${error}`, {
    status: 303,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * "Continue with Apple / Google": remember a state and nonce, then go to the
 * provider. With `?intent=link`, a signed-in client is turning the provider
 * on from Account instead of signing in.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSignInProvider(provider)) return backToSignIn("unavailable");

  let allowed = false;
  try {
    const ip = clientIpFromRequest(req);
    allowed = (await rateLimit({ key: `portal-sso:start:${ip}`, limit: 30, windowMs: 15 * 60 * 1000 })).success;
  } catch {
    allowed = false;
  }
  if (!allowed) return backToSignIn("busy");

  const query = req.nextUrl.searchParams;
  let link: string | null = null;
  if (query.get("intent") === "link") {
    link = portalSessionTokenFromCookie(req.headers.get("cookie"));
    if (!link) return backToSignIn("signed_out");
  }
  const sso = newSsoState(provider, link ? "/portal/account" : query.get("next"), link);
  const destination = authorizeUrl(sso);
  if (!destination) return backToSignIn("unavailable");

  const response = NextResponse.redirect(destination, { status: 303, headers: NO_STORE_HEADERS });
  response.cookies.set(SSO_COOKIE, encodeSsoCookie(sso), ssoCookieOptions());
  return response;
}
