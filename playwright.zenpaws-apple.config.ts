import { defineConfig } from "@playwright/test";

// Sign in with Apple on the live ZenPaws portal. See e2e/zenpaws-apple-sign-in.spec.ts.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "outputs/zenpaws-apple/test-results",
  testMatch: "zenpaws-apple-sign-in.spec.ts",
  workers: 1,
  timeout: 120_000,
  use: {
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  reporter: [["list"]],
});
