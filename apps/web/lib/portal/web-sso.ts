import { randomBytes } from "node:crypto";
import { appBaseUrl } from "@/lib/app-url";
import { appleWebServicesId, verifyAppleIdentityToken } from "./apple-sign-in";
import {
  claimIsTrue,
  IdTokenError,
  jwksFetcher,
  sameString,
  tokenEmail,
  verifyIdToken,
  type RsaJwk,
} from "./id-token";
import type { ProviderIdentity, SignInProvider } from "./identity-sign-in";

/**
 * Single sign-on for the client portal in a web browser: "Continue with
 * Apple" and "Continue with Google" send the browser to the provider, which
 * sends it back to /api/portal/sso/<provider>/callback with an identity token
 * (Apple posts it; Google sends a code we exchange for one). A short-lived
 * cookie ties the round trip together with a random state and nonce.
 */

export const SSO_COOKIE = "zp_sso";
export const SSO_COOKIE_PATH = "/api/portal/sso";
export const SSO_TTL_SECONDS = 10 * 60;

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const getGoogleKeys = jwksFetcher("https://www.googleapis.com/oauth2/v3/certs");

export function googleClientId(): string | null {
  const id = process.env.GOOGLE_SIGN_IN_CLIENT_ID?.trim();
  return id && process.env.GOOGLE_SIGN_IN_CLIENT_SECRET?.trim() ? id : null;
}

export function webSignInOptions(): Record<SignInProvider, boolean> {
  return { apple: Boolean(appleWebServicesId()), google: Boolean(googleClientId()) };
}

export function isSignInProvider(value: string): value is SignInProvider {
  return value === "apple" || value === "google";
}

export function callbackUrl(provider: SignInProvider): string {
  return `${appBaseUrl()}${SSO_COOKIE_PATH}/${provider}/callback`;
}

/** Only portal pages may be the place we land after signing in. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 200) return "/portal";
  if (!/^\/portal(?:[/?#]|$)/.test(value) || value.includes("\\") || value.includes("//")) return "/portal";
  return value;
}

/**
 * `link` is set when a signed-in client is turning the provider on from
 * Account: it holds their portal session credential, because Apple's
 * cross-site form post back doesn't carry the (SameSite=Lax) session cookie.
 * This cookie is HttpOnly, scoped to /api/portal/sso and lives ten minutes.
 */
export type SsoState = { provider: SignInProvider; state: string; nonce: string; next: string; link?: string };

const SESSION_CREDENTIAL = /^[0-9a-f]{16,256}$/;

export function newSsoState(provider: SignInProvider, next: unknown, link?: string | null): SsoState {
  const sso: SsoState = {
    provider,
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    next: safeNextPath(next),
  };
  if (link && SESSION_CREDENTIAL.test(link)) sso.link = link;
  return sso;
}

export function encodeSsoCookie(value: SsoState): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeSsoCookie(raw: string | undefined): SsoState | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<SsoState>;
    if (
      typeof value.provider !== "string" ||
      !isSignInProvider(value.provider) ||
      typeof value.state !== "string" ||
      typeof value.nonce !== "string"
    ) {
      return null;
    }
    const sso: SsoState = { provider: value.provider, state: value.state, nonce: value.nonce, next: safeNextPath(value.next) };
    if (typeof value.link === "string" && SESSION_CREDENTIAL.test(value.link)) sso.link = value.link;
    return sso;
  } catch {
    return null;
  }
}

/** The state the provider returned matches the one this browser started with. */
export function stateMatches(saved: SsoState | null, provider: SignInProvider, returned: unknown): saved is SsoState {
  return Boolean(
    saved && saved.provider === provider && typeof returned === "string" && sameString(saved.state, returned),
  );
}

/** SameSite=None so Apple's cross-site POST back still carries the cookie. */
export function ssoCookieOptions(maxAge = SSO_TTL_SECONDS) {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? ("none" as const) : ("lax" as const),
    path: SSO_COOKIE_PATH,
    maxAge,
  };
}

export function authorizeUrl(sso: SsoState): string | null {
  if (sso.provider === "apple") {
    const clientId = appleWebServicesId();
    if (!clientId) return null;
    const url = new URL("https://appleid.apple.com/auth/authorize");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl("apple"),
      response_type: "code id_token",
      response_mode: "form_post",
      scope: "name email",
      state: sso.state,
      nonce: sso.nonce,
    }).toString();
    return url.toString();
  }
  const clientId = googleClientId();
  if (!clientId) return null;
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl("google"),
    response_type: "code",
    scope: "openid email profile",
    state: sso.state,
    nonce: sso.nonce,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export type ResolvedIdentity = ProviderIdentity & { givenName?: string; familyName?: string };

const trimName = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : undefined;

/**
 * Apple's form post: the identity token, and on the very first sign-in only
 * a `user` field with the person's name (not signed, so used for the name only).
 */
export async function appleIdentityFromPost(
  form: { idToken: unknown; user: unknown },
  nonce: string,
): Promise<ResolvedIdentity> {
  const servicesId = appleWebServicesId();
  if (!servicesId || typeof form.idToken !== "string") throw new IdTokenError("Missing token");
  const identity = await verifyAppleIdentityToken(form.idToken, { audiences: [servicesId], nonce });
  let givenName: string | undefined;
  let familyName: string | undefined;
  if (typeof form.user === "string" && form.user.length <= 2048) {
    try {
      const user = JSON.parse(form.user) as { name?: { firstName?: unknown; lastName?: unknown } };
      givenName = trimName(user.name?.firstName);
      familyName = trimName(user.name?.lastName);
    } catch {
      // A malformed name is not worth failing the sign-in over.
    }
  }
  return { ...identity, givenName, familyName };
}

export async function verifyGoogleIdToken(
  token: string,
  options: { clientId: string; nonce: string; now?: Date; getKeys?: (force: boolean) => Promise<RsaJwk[]> },
): Promise<ResolvedIdentity> {
  const { subject, claims } = await verifyIdToken(token, {
    issuers: GOOGLE_ISSUERS,
    audiences: [options.clientId],
    nonce: options.nonce,
    now: options.now,
    getKeys: options.getKeys ?? getGoogleKeys,
  });
  const email = tokenEmail(claims);
  return {
    subject,
    email,
    emailVerified: Boolean(email) && claimIsTrue(claims.email_verified),
    givenName: trimName(claims.given_name),
    familyName: trimName(claims.family_name),
  };
}

/** Swap Google's one-time code for its identity token, then check that token. */
export async function googleIdentityFromCode(code: unknown, nonce: string): Promise<ResolvedIdentity> {
  const clientId = googleClientId();
  const clientSecret = process.env.GOOGLE_SIGN_IN_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || typeof code !== "string" || code.length > 2048) {
    throw new IdTokenError("Missing code");
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl("google"),
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new IdTokenError("Google rejected the sign-in code");
  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new IdTokenError("Google sent no identity token");
  return verifyGoogleIdToken(body.id_token, { clientId, nonce });
}
