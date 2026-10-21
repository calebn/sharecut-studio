import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * Firefox is not a compat-matrix engine, so the drawer-drag spec runs on it
 * from this opt-in config: `npm run test:e2e:drawer-firefox` after the E2E build.
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./e2e-compat",
  testMatch: "**/drawer-drag.spec.ts",
  outputDir: "./test-results/firefox",
  projects: [{ name: "firefox", use: { ...devices["Desktop Firefox"] } }],
});
