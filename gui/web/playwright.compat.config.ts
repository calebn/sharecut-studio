import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

const projects = [
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
  projects,
});
