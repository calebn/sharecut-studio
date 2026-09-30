import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-storybook",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:6010",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run storybook -- --port 6010 --ci --no-open",
    url: "http://127.0.0.1:6010",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
