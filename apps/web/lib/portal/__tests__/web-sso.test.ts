import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdTokenError, type RsaJwk } from "../id-token";
import {
  appleIdentityFromPost,
  authorizeUrl,
  decodeSsoCookie,
  encodeSsoCookie,
  newSsoState,
  safeNextPath,
  stateMatches,
  verifyGoogleIdToken,
  webSignInOptions,
} from "../web-sso";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as RsaJwk), kid: "google-kid", alg: "RS256" };
const keys = async () => [jwk];
const NOW = new Date("2026-10-31T12:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

function googleToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: "google-kid" });
  const body = encode({
    iss: "https://accounts.google.com",
    aud: "client-123.apps.googleusercontent.com",
    exp: nowSeconds + 600,
    iat: nowSeconds,
    sub: "1098765",
    nonce: "nonce-g",
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

const verifyGoogle = (token: string, nonce = "nonce-g") =>
  verifyGoogleIdToken(token, {
    clientId: "client-123.apps.googleusercontent.com",
    nonce,
    now: NOW,
    getKeys: keys,
  });

describe("safeNextPath", () => {
  it("keeps portal paths", () => {
    expect(safeNextPath("/portal")).toBe("/portal");
    expect(safeNextPath("/portal/book?when=today")).toBe("/portal/book?when=today");
  });

  it("falls back to the portal home for anything else", () => {
    for (const value of [undefined, "", "/login", "https://evil.example/portal", "//evil.example", "/portal//evil", "/portalx", "/portal\\..\\x", 42]) {
      expect(safeNextPath(value)).toBe("/portal");
    }
  });
});

describe("the sign-in round trip cookie", () => {
  it("round-trips and matches only the same provider and state", () => {
    const sso = newSsoState("google", "/portal/pets");
    const saved = decodeSsoCookie(encodeSsoCookie(sso));
    expect(saved).toEqual(sso);
    expect(stateMatches(saved, "google", sso.state)).toBe(true);
    expect(stateMatches(saved, "apple", sso.state)).toBe(false);
    expect(stateMatches(saved, "google", `${sso.state}x`)).toBe(false);
    expect(stateMatches(saved, "google", null)).toBe(false);
    expect(stateMatches(null, "google", sso.state)).toBe(false);
  });

  it("uses fresh random state and nonce every time", () => {
    const first = newSsoState("apple", null);
    const second = newSsoState("apple", null);
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects tampered or foreign cookies", () => {
    expect(decodeSsoCookie(undefined)).toBeNull();
    expect(decodeSsoCookie("not-json")).toBeNull();
    const foreign = Buffer.from(JSON.stringify({ provider: "github", state: "s", nonce: "n" })).toString("base64url");
    expect(decodeSsoCookie(foreign)).toBeNull();
    const redirected = Buffer.from(JSON.stringify({ provider: "apple", state: "s", nonce: "n", next: "https://evil.example" })).toString("base64url");
    expect(decodeSsoCookie(redirected)?.next).toBe("/portal");
  });

  it("keeps a signed-in client's session only when it looks like one", () => {
    const session = "b".repeat(64);
    expect(decodeSsoCookie(encodeSsoCookie(newSsoState("apple", null, session)))?.link).toBe(session);
    expect(newSsoState("apple", null, "not a session; path=/").link).toBeUndefined();
    expect(newSsoState("apple", null).link).toBeUndefined();
    const forged = Buffer.from(JSON.stringify({ provider: "apple", state: "s", nonce: "n", link: { $ne: null } })).toString("base64url");
    expect(decodeSsoCookie(forged)?.link).toBeUndefined();
  });
});

describe("provider settings", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    vi.stubEnv("APPLE_SIGN_IN_WEB_SERVICES_ID", "");
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_SECRET", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("offers nothing until a provider is configured", () => {
    expect(webSignInOptions()).toEqual({ apple: false, google: false });
    expect(authorizeUrl(newSsoState("apple", null))).toBeNull();
    expect(authorizeUrl(newSsoState("google", null))).toBeNull();
  });

  it("needs both the Google client id and secret", () => {
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_ID", "client-123.apps.googleusercontent.com");
    expect(webSignInOptions().google).toBe(false);
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_SECRET", "secret");
    expect(webSignInOptions().google).toBe(true);
  });

  it("sends Apple the Services ID, form-post callback, state and nonce", () => {
    vi.stubEnv("APPLE_SIGN_IN_WEB_SERVICES_ID", "com.example.clinic.web");
    const sso = newSsoState("apple", null);
    const url = new URL(authorizeUrl(sso)!);
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "com.example.clinic.web",
      redirect_uri: "https://app.example.com/api/portal/sso/apple/callback",
      response_type: "code id_token",
      response_mode: "form_post",
      scope: "name email",
      state: sso.state,
      nonce: sso.nonce,
    });
  });

  it("sends Google the client id, callback, OpenID scopes, state and nonce", () => {
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_ID", "client-123.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_SECRET", "secret");
    const sso = newSsoState("google", null);
    const url = new URL(authorizeUrl(sso)!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/portal/sso/google/callback");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(sso.state);
    expect(url.searchParams.get("nonce")).toBe(sso.nonce);
    expect(url.toString()).not.toContain("secret");
  });

  it("refuses an Apple post when web sign-in is off", async () => {
    await expect(appleIdentityFromPost({ idToken: "a.b.c", user: null }, "n")).rejects.toBeInstanceOf(IdTokenError);
  });
});

describe("verifyGoogleIdToken", () => {
  it("accepts a fresh token for our client with the expected nonce", async () => {
    const identity = await verifyGoogle(
      googleToken({ email: "Owner@Example.com", email_verified: true, given_name: "Sam", family_name: "Rivera" }),
    );
    expect(identity).toEqual({
      subject: "1098765",
      email: "Owner@Example.com",
      emailVerified: true,
      givenName: "Sam",
      familyName: "Rivera",
    });
  });

  it("accepts Google's bare issuer form too", async () => {
    await expect(verifyGoogle(googleToken({ iss: "accounts.google.com" }))).resolves.toMatchObject({ subject: "1098765" });
  });

  it("treats an unverified email as unverified", async () => {
    const identity = await verifyGoogle(googleToken({ email: "x@example.com", email_verified: false }));
    expect(identity.emailVerified).toBe(false);
  });

  it("rejects another app's token, another issuer, a stale token or the wrong nonce", async () => {
    await expect(verifyGoogle(googleToken({ aud: "someone-else" }))).rejects.toThrow("Wrong audience");
    await expect(verifyGoogle(googleToken({ iss: "https://appleid.apple.com" }))).rejects.toThrow("Wrong issuer");
    await expect(verifyGoogle(googleToken({ exp: nowSeconds - 3600 }))).rejects.toThrow("Expired token");
    await expect(verifyGoogle(googleToken({}), "other-nonce")).rejects.toThrow("Nonce mismatch");
  });
});
