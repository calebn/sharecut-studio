import { defineConfig, devices, type Project } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * Chromium's built-in fake capture device, so recording specs call the real
 * `getUserMedia` (then the keeper AudioWorklet, OPFS writer and upload) with no
 * hardware or permission prompt. Specs that stub `navigator.mediaDevices`
 * are unaffected.
 */
const CHROMIUM_FAKE_MEDIA = {
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};

const projects: Project[] = [
  {
    name: "chromium",
    use: { ...devices["Desktop Chrome"], launchOptions: CHROMIUM_FAKE_MEDIA },
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
      launchOptions: CHROMIUM_FAKE_MEDIA,
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
