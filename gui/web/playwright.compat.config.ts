import { defineConfig, devices, type Project } from "@playwright/test";
import baseConfig from "./playwright.config";

const projects: Project[] = [
  {
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  },
  {
    name: "webkit",
    use: { ...devices["Desktop Safari"] },
  },
];

if (process.env.E2E_BRANDED_CHROME === "1") {
  projects.push({
    name: "chrome",
    use: { ...devices["Desktop Chrome"], channel: "chrome" },
  });
}

export default defineConfig({
  ...baseConfig,
  testDir: "./e2e-compat",
  // One web server and one live project fixture are shared by every test.
  fullyParallel: false,
  workers: 1,
  // Keep the main suite's traces and workspace stamp when both runs share a job.
  outputDir: "./test-results/compat",
  projects,
});
