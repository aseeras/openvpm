import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterVercelAnalyticsEvent } from "../analytics-privacy";

describe("Vercel Analytics capability privacy", () => {
  it.each([
    "https://app.openvpm.com/capture/raw-secret-token",
    "https://app.openvpm.com/capture/raw-secret-token?source=qr",
    "https://app.openvpm.com/sign/raw-secret-token",
    "https://app.openvpm.com/treatment-plan/raw-secret-token",
    "/capture/raw-secret-token",
    "/sign/raw-secret-token",
    "/treatment-plan/raw-secret-token",
  ])("drops capability-page events before they are sent: %s", (url) => {
    expect(filterVercelAnalyticsEvent({ type: "pageview", url })).toBeNull();
    expect(filterVercelAnalyticsEvent({ type: "event", url })).toBeNull();
  });

  it("leaves ordinary analytics events unchanged", () => {
    const event = {
      type: "pageview" as const,
      url: "https://app.openvpm.com/patients",
    };
    expect(filterVercelAnalyticsEvent(event)).toBe(event);
  });

  it("wires the privacy filter into the only Vercel Analytics component", () => {
    const source = readFileSync("lib/providers.tsx", "utf8");
    expect(source).toContain(
      "<Analytics beforeSend={filterVercelAnalyticsEvent} />",
    );
  });

  it("loads Vercel Analytics only on Vercel builds", () => {
    const source = readFileSync("lib/providers.tsx", "utf8");
    expect(source).toContain('process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "1"');
    const config = readFileSync("next.config.js", "utf8");
    expect(config).toContain(
      'NEXT_PUBLIC_VERCEL_ANALYTICS: process.env.VERCEL === "1" ? "1" : ""',
    );
  });
});
