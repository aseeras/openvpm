import { randomBytes } from "node:crypto";
import {
  claimIsTrue,
  ID_TOKEN_MAX_LENGTH,
  IdTokenError,
  jwksFetcher,
  tokenEmail,
  verifyIdToken,
  type RsaJwk,
} from "./id-token";

/**
 * Sign in with Apple for the client portal. The iPhone app asks Apple for an
 * identity token (a JWT Apple signs) and posts it here; on the web, Apple
 * posts one back to /api/portal/sso/apple/callback. We check Apple's
 * signature, that it was issued for our app or website, that it is fresh,
 * and that it carries the one-time nonce we handed out, then trust its `sub`
 * (a stable Apple user id, the same for every app and site of one developer
 * team).
 */

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

export const APPLE_NONCE_COOKIE = "zp_apple_nonce";
export const APPLE_NONCE_TTL_SECONDS = 10 * 60;
export const APPLE_IDENTITY_TOKEN_MAX_LENGTH = ID_TOKEN_MAX_LENGTH;

export type AppleJwk = RsaJwk;
export type AppleIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  privateRelayEmail: boolean;
};

export { IdTokenError as AppleTokenError };

/** Bundle ids (or Services ids) allowed as the token audience; empty = off. */
export function appleSignInClientIds(): string[] {
  return (process.env.APPLE_SIGN_IN_CLIENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function appleSignInEnabled(): boolean {
  return appleSignInClientIds().length > 0;
}

/** The Services ID that Sign in with Apple on the website runs under; null = off. */
export function appleWebServicesId(): string | null {
  const id = process.env.APPLE_SIGN_IN_WEB_SERVICES_ID?.trim();
  return id && /^[A-Za-z0-9.-]{3,255}$/.test(id) ? id : null;
}

export function generateAppleNonce(): string {
  return randomBytes(24).toString("hex");
}

const getAppleKeys = jwksFetcher(APPLE_KEYS_URL);

export async function verifyAppleIdentityToken(
  token: string,
  options: {
    audiences: string[];
    nonce: string;
    now?: Date;
    getKeys?: (force: boolean) => Promise<AppleJwk[]>;
  },
): Promise<AppleIdentity> {
  const { subject, claims } = await verifyIdToken(token, {
    issuers: [APPLE_ISSUER],
    audiences: options.audiences,
    nonce: options.nonce,
    now: options.now,
    getKeys: options.getKeys ?? getAppleKeys,
  });
  const email = tokenEmail(claims);
  return {
    subject,
    email,
    emailVerified: Boolean(email) && claimIsTrue(claims.email_verified),
    privateRelayEmail: claimIsTrue(claims.is_private_email),
  };
}
