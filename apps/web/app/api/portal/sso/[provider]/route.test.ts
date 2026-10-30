import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeSsoCookie, newSsoState, SSO_COOKIE } from "@/lib/portal/web-sso";

const signIn = vi.hoisted(() => ({ result: "raw-session-token" as string | null, calls: [] as unknown[] }));
const google = vi.hoisted(() => ({ identity: null as unknown, error: null as Error | null, nonces: [] as string[] }));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: async (_db: unknown, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/portal/identity-sign-in", () => ({
  signInWithProviderIdentity: async (_tx: unknown, input: unknown) => {
    signIn.calls.push(input);
    return signIn.result;
  },
}));
vi.mock("@/lib/portal/web-sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/web-sso")>()),
  googleIdentityFromCode: async (_code: unknown, nonce: string) => {
    google.nonces.push(nonce);
    if (google.error) throw google.error;
    return google.identity;
  },
}));

const { GET: start } = await import("./start/route");
const { GET: googleCallback, POST: appleCallback } = await import("./callback/route");
const { IdTokenError } = await import("@/lib/portal/id-token");

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

function request(url: string, init: { cookie?: string; form?: Record<string, string> } = {}) {
  const headers = new Headers({ "user-agent": "vitest" });
  if (init.cookie) headers.set("cookie", `${SSO_COOKIE}=${init.cookie}`);
  if (!init.form) return new NextRequest(url, { headers });
  headers.set("content-type", "application/x-www-form-urlencoded");
  return new NextRequest(url, { method: "POST", headers, body: new URLSearchParams(init.form).toString() });
}

const location = (response: Response) => new URL(response.headers.get("location")!);
const setCookie = (response: Response) => response.headers.getSetCookie().join("\n");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
  vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_ID", "client-123.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_SIGN_IN_CLIENT_SECRET", "secret");
  vi.stubEnv("APPLE_SIGN_IN_WEB_SERVICES_ID", "");
  signIn.result = "raw-session-token";
  signIn.calls = [];
  google.identity = { subject: "g-1", email: "owner@example.com", emailVerified: true, givenName: "Sam" };
  google.error = null;
  google.nonces = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/portal/sso/[provider]/start", () => {
  it("sends the browser to Google with a state cookie for the round trip", async () => {
    const response = await start(request("https://app.example.com/api/portal/sso/google/start?next=/portal/book"), params("google"));
    expect(response.status).toBe(303);
    const url = location(response);
    expect(url.host).toBe("accounts.google.com");
    expect(setCookie(response)).toContain(`${SSO_COOKIE}=`);
    expect(setCookie(response)).toContain("HttpOnly");
    expect(setCookie(response)).toContain("Path=/api/portal/sso");
  });

  it("returns to the sign-in page when the provider isn't set up or isn't known", async () => {
    for (const provider of ["apple", "github"]) {
      const response = await start(request(`https://app.example.com/api/portal/sso/${provider}/start`), params(provider));
      expect(location(response).toString()).toBe("https://app.example.com/portal/account?sso_error=unavailable");
    }
  });
});

describe("Google callback", () => {
  const sso = newSsoState("google", "/portal/book");
  const callback = (query: string, cookie: string | undefined = encodeSsoCookie(sso)) =>
    googleCallback(request(`https://app.example.com/api/portal/sso/google/callback?${query}`, { cookie }), params("google"));

  it("signs the client in, lands on the page they started from and spends the state", async () => {
    const response = await callback(`state=${sso.state}&code=abc`);
    expect(response.status).toBe(303);
    expect(location(response).toString()).toBe("https://app.example.com/portal/book");
    expect(setCookie(response)).toContain("raw-session-token");
    expect(setCookie(response)).toMatch(new RegExp(`${SSO_COOKIE}=;`));
    expect(google.nonces).toEqual([sso.nonce]);
    expect(signIn.calls).toEqual([
      expect.objectContaining({ provider: "google", givenName: "Sam", identity: expect.objectContaining({ subject: "g-1" }) }),
    ]);
  });

  it("refuses a state that doesn't match this browser's sign-in", async () => {
    for (const response of [await callback("state=forged&code=abc"), await callback(`state=${sso.state}&code=abc`, "")]) {
      expect(location(response).searchParams.get("sso_error")).toBe("expired");
      expect(setCookie(response)).not.toContain("raw-session-token");
    }
    expect(google.nonces).toEqual([]);
  });

  it("refuses a state started for Apple", async () => {
    const apple = newSsoState("apple", null);
    const response = await callback(`state=${apple.state}&code=abc`, encodeSsoCookie(apple));
    expect(location(response).searchParams.get("sso_error")).toBe("expired");
  });

  it("treats backing out at Google as cancelled", async () => {
    const response = await callback(`state=${sso.state}&error=access_denied`);
    expect(location(response).searchParams.get("sso_error")).toBe("cancelled");
    expect(signIn.calls).toEqual([]);
  });

  it("reports a token that doesn't check out", async () => {
    google.error = new IdTokenError("Nonce mismatch");
    const response = await callback(`state=${sso.state}&code=abc`);
    expect(location(response).searchParams.get("sso_error")).toBe("failed");
    expect(signIn.calls).toEqual([]);
  });

  it("says so when the identity can't be matched to one client", async () => {
    signIn.result = null;
    const response = await callback(`state=${sso.state}&code=abc`);
    expect(location(response).searchParams.get("sso_error")).toBe("not_linked");
    expect(setCookie(response)).not.toContain("raw-session-token");
  });
});

describe("Apple callback", () => {
  it("only accepts Apple's form post on the Apple path", async () => {
    const sso = newSsoState("apple", null);
    const response = await appleCallback(
      request("https://app.example.com/api/portal/sso/google/callback", {
        cookie: encodeSsoCookie(sso),
        form: { state: sso.state, id_token: "a.b.c" },
      }),
      params("google"),
    );
    expect(location(response).searchParams.get("sso_error")).toBe("unavailable");
  });

  it("rejects a forged state before looking at the token", async () => {
    const sso = newSsoState("apple", null);
    const response = await appleCallback(
      request("https://app.example.com/api/portal/sso/apple/callback", {
        cookie: encodeSsoCookie(sso),
        form: { state: "forged", id_token: "a.b.c" },
      }),
      params("apple"),
    );
    expect(location(response).searchParams.get("sso_error")).toBe("expired");
    expect(signIn.calls).toEqual([]);
  });
});
