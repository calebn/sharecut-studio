import {
  devices,
  type PlaywrightTestConfig,
  type Project,
} from "@playwright/test";
import { afterAll, expect, it, vi } from "vitest";
import compatConfig from "../playwright.compat.config";
import mainConfig from "../playwright.config";

const originalProject = vi.hoisted(() => process.env.DAW_E2E_PROJECT);

vi.mock("./liveProject", () => ({
  copyUxDemoProject: () => "/tmp/axe-profile-project.json",
  prepareLiveE2eProject: () => "/tmp/axe-profile-project.json",
}));
vi.mock("./runtimeEnv", () => ({ e2eRuntimeEnv: () => ({}) }));

afterAll(() => {
  if (originalProject === undefined) delete process.env.DAW_E2E_PROJECT;
  else process.env.DAW_E2E_PROJECT = originalProject;
});

function inheritedProfile(config: PlaywrightTestConfig, project?: Project) {
  const use = { ...config.use, ...project?.use };
  return {
    viewport:
      use.viewport === undefined
        ? devices["Desktop Chrome"].viewport
        : use.viewport,
    colorScheme: use.colorScheme === undefined ? "light" : use.colorScheme,
    reducedMotion:
      use.reducedMotion === undefined ? "no-preference" : use.reducedMotion,
  };
}

function expectExactMainProfiles(
  main: PlaywrightTestConfig,
  compat: PlaywrightTestConfig,
) {
  expect(main.projects).toBeUndefined();
  const chromium = compat.projects?.find(({ name }) => name === "chromium");
  expect(chromium).toBeDefined();
  const mainProfile = inheritedProfile(main);
  const compatProfile = inheritedProfile(compat, chromium);
  expect(compatProfile).toEqual(mainProfile);
  expect(mainProfile).toEqual({
    viewport: devices["Desktop Chrome"].viewport,
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
}

it("keeps the omitted wordbar's inherited Chromium profile and comment recovery's base media profile exact", () => {
  expectExactMainProfiles(mainConfig, compatConfig);
});

it.each(["main", "compat"] as const)(
  "rejects inherited viewport and media drift in the actual %s config",
  (side) => {
    const drifts = [
      { viewport: { width: 800, height: 600 } },
      { colorScheme: "dark" as const },
      { reducedMotion: "reduce" as const },
    ];
    for (const drift of drifts) {
      const main = { ...mainConfig, use: { ...mainConfig.use } };
      const compat = {
        ...compatConfig,
        projects: compatConfig.projects!.map((project) => ({
          ...project,
          use: { ...project.use },
        })),
      };
      if (side === "main") Object.assign(main.use, drift);
      else {
        Object.assign(
          compat.projects.find(({ name }) => name === "chromium")!.use,
          drift,
        );
      }
      expect(() => expectExactMainProfiles(main, compat)).toThrow();
    }
  },
);
