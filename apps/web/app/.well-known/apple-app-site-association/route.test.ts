import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("apple-app-site-association", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("publishes nothing until an app is configured", async () => {
    vi.stubEnv("APPLE_APP_LINK_APP_IDS", "");
    vi.stubEnv("APPLE_WEB_CREDENTIAL_APP_IDS", "");
    expect(GET().status).toBe(404);
  });

  it("lists valid app ids for portal links only", async () => {
    vi.stubEnv("APPLE_APP_LINK_APP_IDS", "ABCDE12345.com.example.client, bad id");
    vi.stubEnv("APPLE_WEB_CREDENTIAL_APP_IDS", "");
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual([
      "ABCDE12345.com.example.client",
    ]);
    expect(body.applinks.details[0].components).toEqual([
      { "/": "/portal/*", comment: "Client portal" },
    ]);
    expect(body).not.toHaveProperty("webcredentials");
  });

  it("lets saved passwords fill in the listed apps without adding app links", async () => {
    vi.stubEnv("APPLE_APP_LINK_APP_IDS", "");
    vi.stubEnv("APPLE_WEB_CREDENTIAL_APP_IDS", "ABCDE12345.com.example.staff,nope");
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webcredentials).toEqual({ apps: ["ABCDE12345.com.example.staff"] });
    expect(body).not.toHaveProperty("applinks");
  });
});
