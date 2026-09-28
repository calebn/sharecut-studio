import { defineConfig, devices, type Project } from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS, withLaunchArgs } from "./e2e/launchOptions";
import baseConfig from "./playwright.config";

/**
 * `CHROMIUM_FAKE_MEDIA_ARGS` apply to every spec in the `chromium` and
 * `chrome` projects: a compat spec that must see Chromium's real permission
 * prompt or device list needs its own project without them.
 */
const projects: Project[] = [
  {
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: withLaunchArgs(
        baseConfig.use?.launchOptions,
        CHROMIUM_FAKE_MEDIA_ARGS,
      ),
    },
  },
  {
    name: "webkit",
    use: { ...devices["Desktop Safari"] },
  },
];

if (process.env.E2E_BRANDED_CHROME === "1") {
  projects.push({
    name: "chrome",
    use: {
      ...devices["Desktop Chrome"],
      channel: "chrome",
      launchOptions: withLaunchArgs(
        baseConfig.use?.launchOptions,
        CHROMIUM_FAKE_MEDIA_ARGS,
      ),
    },
  });
}

export default defineConfig({
  ...baseConfig,
  testDir: "./e2e-compat",
  // One web server and one live project fixture are shared by every test.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Keep the main suite's traces and workspace stamp when both runs share a job.
  outputDir: "./test-results/compat",
  projects,
});
