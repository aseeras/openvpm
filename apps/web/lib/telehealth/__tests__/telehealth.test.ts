import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJoinUrl,
  createVisitRoom,
  deleteVisitRoom,
  telehealthVideoConfigured,
} from "../daily";
import { telehealthSettings, TELEHEALTH_REASONS } from "../visits";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubDaily() {
  vi.stubEnv("DAILY_API_KEY", "test-key");
  vi.stubEnv("DAILY_DOMAIN", "clinic");
  vi.stubEnv("DAILY_API_URL", "");
}

describe("telehealthSettings", () => {
  it("treats missing or malformed settings as not accepting", () => {
    expect(telehealthSettings(null).accepting).toBe(false);
    expect(telehealthSettings({ telehealth: "yes" }).accepting).toBe(false);
    expect(
      telehealthSettings({ telehealth: { accepting: "true" } }).accepting,
    ).toBe(false);
    expect(
      telehealthSettings({ telehealth: { accepting: true } }).accepting,
    ).toBe(true);
  });

  it("offers a fixed list of visit reasons", () => {
    expect(TELEHEALTH_REASONS).toContain("Something else");
  });
});

describe("Daily video rooms", () => {
  it("is off without both a key and a valid domain", () => {
    vi.stubEnv("DAILY_API_KEY", "test-key");
    vi.stubEnv("DAILY_DOMAIN", "not a domain!");
    expect(telehealthVideoConfigured()).toBe(false);
    vi.stubEnv("DAILY_DOMAIN", "clinic");
    expect(telehealthVideoConfigured()).toBe(true);
    vi.stubEnv("DAILY_API_KEY", "");
    expect(telehealthVideoConfigured()).toBe(false);
  });

  it("creates private, expiring rooms that cannot be recorded", async () => {
    stubDaily();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ name: body.name }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const room = await createVisitRoom();
    expect(room.name).toMatch(/^visit-[0-9a-f]{24}$/);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.daily.co/v1/rooms");
    const body = JSON.parse(String(init.body));
    expect(body.privacy).toBe("private");
    expect(body.properties.exp).toBeGreaterThan(Date.now() / 1000);
    expect(body.properties.eject_at_room_exp).toBe(true);
    expect(body.properties).not.toHaveProperty("enable_recording");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
  });

  it("builds a join link on the clinic's own Daily domain", async () => {
    stubDaily();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: "abc.def" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = await createJoinUrl({
      roomName: "visit-123",
      userName: "Jane Client",
      isClinician: false,
    });
    expect(url).toBe("https://clinic.daily.co/visit-123?t=abc.def");
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
      ),
    );
    expect(body.properties.is_owner).toBe(false);
    expect(body.properties.room_name).toBe("visit-123");
  });

  it("treats an already-deleted room as closed", async () => {
    stubDaily();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(deleteVisitRoom("visit-123")).resolves.toBeUndefined();
  });

  it("surfaces a video service failure", async () => {
    stubDaily();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(createVisitRoom()).rejects.toThrow("HTTP 500");
  });
});

describe("security headers for video visits", () => {
  async function headersWith(domain: string) {
    vi.stubEnv("DAILY_DOMAIN", domain);
    vi.resetModules();
    const mod = await import("../../security-headers.js");
    const byKey = Object.fromEntries(
      (mod.securityHeaders as Array<{ key: string; value: string }>).map(
        (h) => [h.key, h.value],
      ),
    );
    return byKey;
  }

  it("lets only the clinic's Daily origin be framed and use camera and mic", async () => {
    const headers = await headersWith("clinic");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-src 'self' https://clinic.daily.co",
    );
    expect(headers["Permissions-Policy"]).toContain(
      'camera=(self "https://clinic.daily.co")',
    );
    expect(headers["Permissions-Policy"]).toContain(
      'microphone=(self "https://clinic.daily.co")',
    );
    // The clinician's page joins with Daily's script (no eval needed).
    expect(headers["Content-Security-Policy"]).toMatch(/script-src [^;]*https:\/\/\*\.daily\.co/);
    expect(headers["Content-Security-Policy"]).toMatch(/connect-src [^;]*wss:\/\/\*\.daily\.co/);
    expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });

  it("keeps the camera blocked when video visits are not configured", async () => {
    const headers = await headersWith("");
    expect(headers["Content-Security-Policy"]).not.toContain("frame-src");
    expect(headers["Content-Security-Policy"]).not.toContain("daily.co");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
