import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppleTokenError,
  verifyAppleIdentityToken,
  type AppleJwk,
} from "../apple-sign-in";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as AppleJwk), kid: "test-kid", alg: "RS256" };
const keys = async () => [jwk];
const NOW = new Date("2026-10-26T12:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

function token(
  claims: Record<string, unknown>,
  { kid = "test-kid", key = privateKey, alg = "RS256" } = {},
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg, kid });
  const body = encode({
    iss: "https://appleid.apple.com",
    aud: "com.zenpawsdvm.client",
    exp: nowSeconds + 600,
    iat: nowSeconds,
    sub: "001234.abcdef",
    nonce: "nonce-1",
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${signature}`;
}

const verifyWith = (value: string, nonce = "nonce-1") =>
  verifyAppleIdentityToken(value, {
    audiences: ["com.zenpawsdvm.client"],
    nonce,
    now: NOW,
    getKeys: keys,
  });

describe("verifyAppleIdentityToken", () => {
  it("accepts a fresh token for the app with the expected nonce", async () => {
    const identity = await verifyWith(
      token({ email: "pet.owner@example.com", email_verified: "true", is_private_email: "false" }),
    );
    expect(identity).toEqual({
      subject: "001234.abcdef",
      email: "pet.owner@example.com",
      emailVerified: true,
      privateRelayEmail: false,
    });
  });

  it("treats an unverified email as unverified", async () => {
    const identity = await verifyWith(token({ email: "x@example.com", email_verified: false }));
    expect(identity.emailVerified).toBe(false);
  });

  it.each([
    ["another app", token({ aud: "com.example.other" })],
    ["another issuer", token({ iss: "https://evil.example" })],
    ["an expired token", token({ exp: nowSeconds - 3600 })],
    ["a missing nonce", token({ nonce: undefined })],
    ["a different nonce", token({ nonce: "nonce-2" })],
    ["a missing subject", token({ sub: "" })],
    ["an unknown key", token({}, { kid: "nope" })],
    ["a forged signature", token({}, { key: other.privateKey })],
    ["an unsigned token", token({}, { alg: "none" })],
  ])("rejects %s", async (_label, value) => {
    await expect(verifyWith(value)).rejects.toBeInstanceOf(AppleTokenError);
  });

  it("rejects a tampered payload", async () => {
    const [head, , signature] = token({}).split(".");
    const forged = Buffer.from(
      JSON.stringify({ iss: "https://appleid.apple.com", aud: "com.zenpawsdvm.client", exp: nowSeconds + 600, sub: "someone-else", nonce: "nonce-1" }),
    ).toString("base64url");
    await expect(verifyWith(`${head}.${forged}.${signature}`)).rejects.toBeInstanceOf(AppleTokenError);
  });

  it("refreshes Apple's keys once when the token names a new key", async () => {
    const calls: boolean[] = [];
    const identity = await verifyAppleIdentityToken(token({}), {
      audiences: ["com.zenpawsdvm.client"],
      nonce: "nonce-1",
      now: NOW,
      getKeys: async (force) => {
        calls.push(force);
        return force ? [jwk] : [];
      },
    });
    expect(identity.subject).toBe("001234.abcdef");
    expect(calls).toEqual([false, true]);
  });
});
