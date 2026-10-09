import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { e2eBaseURL, e2ePort, repoRoot } from "./e2e/env";
import { copyUxDemoProject, prepareLiveE2eProject } from "./e2e/liveProject";
import { e2eRuntimeEnv } from "./e2e/runtimeEnv";

const e2eInvocationId = `${process.pid}-${e2ePort}`;
e2eRuntimeEnv(process.env, e2eInvocationId);

const uxDemoPath = path.join(
  repoRoot,
  "tests/fixtures/sharecut_ux_demo/episode.project.json",
);
const capturingUxScreens = !!process.env.UX_DEMO_SCREENSHOTS;
const guiProject = capturingUxScreens
  ? copyUxDemoProject(process.env.UX_DEMO_PROJECT ?? uxDemoPath)
  : prepareLiveE2eProject();
if (!capturingUxScreens) {
  process.env.DAW_E2E_PROJECT = guiProject;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalTeardown: capturingUxScreens ? undefined : "./e2e/globalTeardown.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "playwright-report/main.json" }]]
    : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: e2eBaseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite-node/dist/cli.mjs scripts/start-e2e-gui.ts",
    cwd: path.join(repoRoot, "gui/web"),
    url: `${e2eBaseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...e2eRuntimeEnv(process.env, e2eInvocationId),
      DAW_E2E_PROJECT: guiProject,
      DAW_E2E_PIN_PROJECT: capturingUxScreens ? "1" : "",
    },
  },
});
