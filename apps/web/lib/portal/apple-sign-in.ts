import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

/**
 * Sign in with Apple for the client portal. The iPhone app asks Apple for an
 * identity token (a JWT Apple signs) and posts it here; we check Apple's
 * signature, that it was issued for our app, that it is fresh, and that it
 * carries the one-time nonce we handed out, then trust its `sub` (a stable
 * per-app Apple user id).
 */

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const KEY_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export const APPLE_NONCE_COOKIE = "zp_apple_nonce";
export const APPLE_NONCE_TTL_SECONDS = 10 * 60;
export const APPLE_IDENTITY_TOKEN_MAX_LENGTH = 8192;

export type AppleJwk = { kty: string; kid: string; alg?: string; n: string; e: string };
export type AppleIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  privateRelayEmail: boolean;
};

export class AppleTokenError extends Error {}

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

export function generateAppleNonce(): string {
  return randomBytes(24).toString("hex");
}

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;

async function fetchAppleKeys(force = false): Promise<AppleJwk[]> {
  if (!force && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_CACHE_MS) {
    return cachedKeys.keys;
  }
  const response = await fetch(APPLE_KEYS_URL, { cache: "no-store" });
  if (!response.ok) throw new AppleTokenError("Could not reach Apple");
  const body = (await response.json()) as { keys?: AppleJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AppleTokenError("Malformed token");
  }
}

function sameString(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true";
}

export async function verifyAppleIdentityToken(
  token: string,
  options: {
    audiences: string[];
    nonce: string;
    now?: Date;
    getKeys?: (force: boolean) => Promise<AppleJwk[]>;
  },
): Promise<AppleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > APPLE_IDENTITY_TOKEN_MAX_LENGTH) {
    throw new AppleTokenError("Malformed token");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AppleTokenError("Unsupported token");
  }

  const getKeys = options.getKeys ?? fetchAppleKeys;
  let jwk = (await getKeys(false)).find((key) => key.kid === header.kid);
  // Apple rotates keys; refresh once if the token names one we don't have.
  if (!jwk) jwk = (await getKeys(true)).find((key) => key.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") throw new AppleTokenError("Unknown signing key");

  const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    publicKey,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!signed) throw new AppleTokenError("Bad signature");

  const claims = decodeSegment(payloadPart);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== APPLE_ISSUER) throw new AppleTokenError("Wrong issuer");
  if (typeof claims.aud !== "string" || !options.audiences.includes(claims.aud)) {
    throw new AppleTokenError("Wrong audience");
  }
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new AppleTokenError("Expired token");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new AppleTokenError("Token from the future");
  }
  if (typeof claims.nonce !== "string" || !sameString(claims.nonce, options.nonce)) {
    throw new AppleTokenError("Nonce mismatch");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) {
    throw new AppleTokenError("Missing subject");
  }

  const email = typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : null;
  return {
    subject: claims.sub,
    email,
    emailVerified: Boolean(email) && claimIsTrue(claims.email_verified),
    privateRelayEmail: claimIsTrue(claims.is_private_email),
  };
}
