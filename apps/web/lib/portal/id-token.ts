import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/**
 * Checks an OpenID Connect identity token (a JWT signed by Apple or Google):
 * the provider's RS256 signature, the issuer, that it was issued to us, that
 * it is fresh, and that it carries the one-time nonce we handed out.
 */

const KEY_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
export const ID_TOKEN_MAX_LENGTH = 8192;

export type RsaJwk = { kty: string; kid: string; alg?: string; n: string; e: string };
export type VerifiedIdToken = { subject: string; claims: Record<string, unknown> };

export class IdTokenError extends Error {}

const keyCache = new Map<string, { keys: RsaJwk[]; fetchedAt: number }>();

/** A cached reader for a provider's published signing keys. */
export function jwksFetcher(url: string): (force: boolean) => Promise<RsaJwk[]> {
  return async (force) => {
    const cached = keyCache.get(url);
    if (!force && cached && Date.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new IdTokenError("Could not reach the sign-in provider");
    const body = (await response.json()) as { keys?: RsaJwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    keyCache.set(url, { keys, fetchedAt: Date.now() });
    return keys;
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new IdTokenError("Malformed token");
  }
}

export function sameString(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true";
}

export async function verifyIdToken(
  token: string,
  options: {
    issuers: string[];
    audiences: string[];
    nonce: string;
    getKeys: (force: boolean) => Promise<RsaJwk[]>;
    now?: Date;
  },
): Promise<VerifiedIdToken> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > ID_TOKEN_MAX_LENGTH) {
    throw new IdTokenError("Malformed token");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new IdTokenError("Unsupported token");
  }

  let jwk = (await options.getKeys(false)).find((key) => key.kid === header.kid);
  // Providers rotate keys; refresh once if the token names one we don't have.
  if (!jwk) jwk = (await options.getKeys(true)).find((key) => key.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") throw new IdTokenError("Unknown signing key");

  const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    publicKey,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!signed) throw new IdTokenError("Bad signature");

  const claims = decodeSegment(payloadPart);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (typeof claims.iss !== "string" || !options.issuers.includes(claims.iss)) {
    throw new IdTokenError("Wrong issuer");
  }
  if (typeof claims.aud !== "string" || !options.audiences.includes(claims.aud)) {
    throw new IdTokenError("Wrong audience");
  }
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new IdTokenError("Expired token");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new IdTokenError("Token from the future");
  }
  if (typeof claims.nonce !== "string" || !sameString(claims.nonce, options.nonce)) {
    throw new IdTokenError("Nonce mismatch");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) {
    throw new IdTokenError("Missing subject");
  }
  return { subject: claims.sub, claims };
}

/** The email in a token, if it is a plausible length. */
export function tokenEmail(claims: Record<string, unknown>): string | null {
  return typeof claims.email === "string" && claims.email.length <= 320 ? claims.email : null;
}
