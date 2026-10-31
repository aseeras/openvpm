import { defineConfig } from "@playwright/test";

// Read-only check of the live ZenPaws server. See e2e/zenpaws-live-check.spec.ts.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "outputs/zenpaws-live/test-results",
  testMatch: "zenpaws-live-check.spec.ts",
  workers: 1,
  timeout: 180_000,
  use: {
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
