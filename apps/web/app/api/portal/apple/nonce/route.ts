import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/request-origin";
import {
  APPLE_NONCE_COOKIE,
  APPLE_NONCE_TTL_SECONDS,
  appleSignInEnabled,
  generateAppleNonce,
} from "@/lib/portal/apple-sign-in";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/** Hand out a one-time nonce the app passes to Apple, kept in a cookie to check later. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  if (!appleSignInEnabled()) {
    return NextResponse.json({ error: "Sign in with Apple is not available" }, { status: 404, headers: NO_STORE_HEADERS });
  }
  const nonce = generateAppleNonce();
  const response = NextResponse.json({ nonce }, { headers: NO_STORE_HEADERS });
  response.cookies.set(APPLE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/portal/apple",
    maxAge: APPLE_NONCE_TTL_SECONDS,
  });
  return response;
}
