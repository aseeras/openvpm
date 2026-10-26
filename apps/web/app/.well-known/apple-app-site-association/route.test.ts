import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("apple-app-site-association", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("publishes nothing until an app is configured", async () => {
    vi.stubEnv("APPLE_APP_LINK_APP_IDS", "");
    expect(GET().status).toBe(404);
  });

  it("lists valid app ids for portal links only", async () => {
    vi.stubEnv("APPLE_APP_LINK_APP_IDS", "ABCDE12345.com.example.client, bad id");
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual([
      "ABCDE12345.com.example.client",
    ]);
    expect(body.applinks.details[0].components).toEqual([
      { "/": "/portal/*", comment: "Client portal" },
    ]);
  });
});
