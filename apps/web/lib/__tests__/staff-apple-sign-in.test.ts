import { describe, expect, it, vi } from "vitest";
import { appleEmailForMatching, cookieFromHeader, staffAppleIdAliases } from "../staff-apple-sign-in";

describe("staff Sign in with Apple helpers", () => {
  it("reads the nonce cookie from a Cookie header", () => {
    const header = "next-auth.csrf-token=abc; openvpm_staff_apple_nonce=n0nce%2B1; other=x";
    expect(cookieFromHeader(header, "openvpm_staff_apple_nonce")).toBe("n0nce+1");
    expect(cookieFromHeader(header, "missing")).toBeNull();
    expect(cookieFromHeader(undefined, "openvpm_staff_apple_nonce")).toBeNull();
    expect(cookieFromHeader("openvpm_staff_apple_nonce=", "openvpm_staff_apple_nonce")).toBeNull();
  });

  it("matches a staff login by email only when Apple verified it and it isn't a relay address", () => {
    const base = { subject: "s", emailVerified: true, privateRelayEmail: false };
    expect(appleEmailForMatching({ ...base, email: "Vet@Clinic.com" })).toBe("vet@clinic.com");
    expect(appleEmailForMatching({ ...base, email: "vet@clinic.com", emailVerified: false })).toBeNull();
    expect(
      appleEmailForMatching({ ...base, email: "x@privaterelay.appleid.com", privateRelayEmail: true }),
    ).toBeNull();
    expect(appleEmailForMatching({ ...base, email: null })).toBeNull();
  });

  it("reads the Apple IDs named for staff logins", () => {
    vi.stubEnv("APPLE_STAFF_APPLE_IDS", " Me@iCloud.com = Me@Clinic.com ,junk,=x@y.z, a@b.c=d@e.f");
    expect([...staffAppleIdAliases()]).toEqual([
      ["me@icloud.com", "me@clinic.com"],
      ["a@b.c", "d@e.f"],
    ]);
    vi.unstubAllEnvs();
  });
});
