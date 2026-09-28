import { defineConfig, devices, type Project } from "@playwright/test";
import { withLaunchArgs } from "./e2e/launchOptions";
import baseConfig from "./playwright.config";

/**
 * Chromium's built-in fake capture device, so recording specs call the real
 * `getUserMedia` (then the keeper AudioWorklet, OPFS writer and upload) with no
 * hardware or permission prompt. Specs that stub `navigator.mediaDevices`
 * are unaffected. The flags apply to every spec in the `chromium` and
 * `chrome` projects: a compat spec that must see Chromium's real permission
 * prompt or device list needs its own project without them.
 */
const CHROMIUM_FAKE_MEDIA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

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
    // WebKit core flow lands with #704; remove this line there.
    testIgnore: ["**/core-flow.spec.ts"],
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
