import { NextRequest, NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/request-origin";
import {
  APPLE_NONCE_TTL_SECONDS,
  generateAppleNonce,
} from "@/lib/portal/apple-sign-in";
import {
  STAFF_APPLE_NONCE_COOKIE,
  STAFF_APPLE_NONCE_COOKIE_PATH,
  staffAppleSignInEnabled,
} from "@/lib/staff-apple-sign-in";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

/**
 * Hands the staff app a one-time nonce to pass to Apple, kept in an httpOnly
 * cookie that only the sign-in callback and the connect endpoint receive.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  if (!staffAppleSignInEnabled()) {
    return NextResponse.json({ error: "Sign in with Apple is not available" }, { status: 404, headers: NO_STORE_HEADERS });
  }
  const nonce = generateAppleNonce();
  const response = NextResponse.json({ nonce }, { headers: NO_STORE_HEADERS });
  response.cookies.set(STAFF_APPLE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: STAFF_APPLE_NONCE_COOKIE_PATH,
    maxAge: APPLE_NONCE_TTL_SECONDS,
  });
  return response;
}
