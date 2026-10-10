import {
  test as base,
  expect,
  type Page,
  type PlaywrightTestArgs,
  type TestInfo,
} from "@playwright/test";
import { e2eProjectPath } from "./env";

import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { setTheme } from "./theme";
import { buildFixture, json, setZoom, TRACK } from "./touchTimeline";

const CLIENT_ID = "e2e-touch-chrome-reach";
export const SIZES = {
  portrait: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
} as const;

export const original = [
  { id: "env-a", time: 5, value: 1 },
  { id: "env-edge", time: 10, value: 0.8 },
  { id: "env-c", time: 16, value: 1 },
  { id: "env-join", time: 40, value: 1.2 },
];
export const edited = [
  { id: "env-a", time: 5, value: 1 },
  { id: "env-edge", time: 10, value: 0.8 },
  { id: "env-c", time: 16.01, value: 1 },
  { id: "env-join", time: 40, value: 1.2 },
];

export let projectPath: string;
export const test = base.extend<{ compactChromeProject: string }>({
  compactChromeProject: [
    async ({ page }, provideProject) => {
      const fixture = createRelocatedE2eProject("sharecut-e2e-chrome-reach-");
      projectPath = fixture.projectPath;
      await switchE2eProject(projectPath);
      try {
        await provideProject(projectPath);
      } finally {
        await switchE2eProject(e2eProjectPath);
        removeRelocatedE2eProject(fixture.workspaceDir);
      }
    },
    { auto: true },
  ],
});

export async function openAt(
  page: Page,
  size: { width: number; height: number },
  rootPx = 16,
  theme: "dark" | "light" = "dark",
): Promise<void> {
  await page.addInitScript(
    (value) => localStorage.setItem("daw_theme", value),
    theme,
  );
  await page.setViewportSize(size);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (size.width < 768) await openPhoneTimeline(page);
  await setTheme(page, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await setZoom(page, 3);
}

export async function receipt(info: TestInfo, name: string, value: unknown) {
  json(info, name, value);
  await info.attach(name, {
    body: JSON.stringify(value),
    contentType: "application/json",
  });
}

export const railHistory = (page: Page) =>
  page.getByRole("group", { name: "Undo and redo" });
export const compactHistory = (page: Page) =>
  page.locator(".bottom-sheet--compact").getByRole("group", {
    name: "Undo and redo",
  });

export async function savedEnvelope(page: Page) {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const body = (await res.json()) as {
    envelopes: {
      track_id: string;
      points: { id: string; time: number; value: number }[];
    }[];
  };
  return body.envelopes.find((e) => e.track_id === TRACK)?.points;
}

export type Fixtures = Pick<PlaywrightTestArgs, "page" | "context"> & {
  browserName: string;
};
