import { defineConfig, devices } from "@playwright/test";

// End-to-end check of the live ZenPaws server. See e2e/zenpaws-live-check.spec.ts.
// "vpm-web" is the web app on a desktop; "iphone" is the same pages at the
// size the ZenPaws staff and client iPhone apps show them.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "outputs/zenpaws-live/test-results",
  testMatch: "zenpaws-live-check.spec.ts",
  workers: 1,
  timeout: 240_000,
  use: {
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [
    { name: "vpm-web", use: { viewport: { width: 1366, height: 900 } } },
    {
      name: "iphone",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
  reporter: [["list"]],
});
