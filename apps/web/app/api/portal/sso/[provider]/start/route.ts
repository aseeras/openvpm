import { NextRequest, NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-url";
import { clientIpFromRequest } from "@/lib/request-ip";
import { rateLimit } from "@/lib/rate-limit";
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

/** "Continue with Apple / Google": remember a state and nonce, then go to the provider. */
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

  const sso = newSsoState(provider, req.nextUrl.searchParams.get("next"));
  const destination = authorizeUrl(sso);
  if (!destination) return backToSignIn("unavailable");

  const response = NextResponse.redirect(destination, { status: 303, headers: NO_STORE_HEADERS });
  response.cookies.set(SSO_COOKIE, encodeSsoCookie(sso), ssoCookieOptions());
  return response;
}
