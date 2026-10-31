import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4, resetAt: new Date() })),
  verify: vi.fn(),
  findStaff: vi.fn(),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/rate-limit", () => ({ clearRateLimit: vi.fn(), rateLimit: mocks.rateLimit }));
vi.mock("@/lib/portal/apple-sign-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/apple-sign-in")>()),
  verifyAppleIdentityToken: mocks.verify,
}));
vi.mock("@/lib/staff-apple-sign-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-apple-sign-in")>()),
  findStaffForAppleIdentity: mocks.findStaff,
}));

const { authOptions } = await import("../auth");
const { AppleTokenError } = await import("@/lib/portal/apple-sign-in");

type AppleProvider = {
  options: {
    id?: string;
    authorize: (
      credentials: { identityToken?: string } | undefined,
      req: { headers: Record<string, string> },
    ) => Promise<unknown>;
  };
};

function appleProvider() {
  const provider = (authOptions.providers as unknown as AppleProvider[]).find((p) => p.options.id === "apple");
  if (!provider) throw new Error("apple provider missing");
  return provider.options;
}

const withNonce = { headers: { cookie: "a=b; openvpm_staff_apple_nonce=nonce-1", "x-forwarded-for": "203.0.113.9" } };
const staffUser = {
  id: "user-1",
  email: "vet@clinic.example",
  name: "Dr Vet",
  role: "veterinarian",
  practiceId: "practice-1",
  passwordHash: "never returned",
};

beforeEach(() => {
  vi.stubEnv("APPLE_STAFF_SIGN_IN_CLIENT_IDS", "com.example.staff");
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
  mocks.verify.mockResolvedValue({ subject: "apple-1", email: null, emailVerified: false, privateRelayEmail: false });
  mocks.findStaff.mockResolvedValue(staffUser);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("staff Sign in with Apple provider", () => {
  it("opens the connected staff login after checking the token against the staff app and the nonce cookie", async () => {
    const user = await appleProvider().authorize({ identityToken: "token" }, withNonce);
    expect(user).toEqual({
      id: "user-1",
      email: "vet@clinic.example",
      name: "Dr Vet",
      role: "veterinarian",
      practiceId: "practice-1",
    });
    expect(mocks.verify).toHaveBeenCalledWith("token", { audiences: ["com.example.staff"], nonce: "nonce-1" });
  });

  it("is off until the server names a staff app", async () => {
    vi.stubEnv("APPLE_STAFF_SIGN_IN_CLIENT_IDS", "");
    await expect(appleProvider().authorize({ identityToken: "token" }, withNonce)).rejects.toThrow("apple_failed");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("needs the nonce cookie", async () => {
    await expect(appleProvider().authorize({ identityToken: "token" }, { headers: {} })).rejects.toThrow("apple_expired");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects a token Apple's checks refuse", async () => {
    mocks.verify.mockRejectedValue(new AppleTokenError("Nonce mismatch"));
    await expect(appleProvider().authorize({ identityToken: "token" }, withNonce)).rejects.toThrow("apple_failed");
    expect(mocks.findStaff).not.toHaveBeenCalled();
  });

  it("says so when the Apple ID isn't connected to any staff login", async () => {
    mocks.findStaff.mockResolvedValue(null);
    await expect(appleProvider().authorize({ identityToken: "token" }, withNonce)).rejects.toThrow("apple_not_connected");
  });

  it("stops after too many attempts from one address", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ success: false, remaining: 0, resetAt: new Date() });
    await expect(appleProvider().authorize({ identityToken: "token" }, withNonce)).rejects.toThrow("apple_busy");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
