import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme, type Theme } from "../e2e/theme";
import { save } from "../e2e/touchTimeline";

const CLIENT_ID = "e2e-actionbar-ruler";
const VIEWPORTS = {
  phone: { width: 360, height: 800 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 720 },
  "desktop-short": { width: 1280, height: 440 },
} as const;

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-actionbar-ruler-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function suggestOnFirstDialogueTrack(page: Page): Promise<void> {
  const trackId = await page.evaluate(async (path) => {
    const res = await fetch(
      `/api/project?path=${encodeURIComponent(path)}&phase=shell`,
    );
    const project = (await res.json()) as {
      tracks: { id: string; role?: string }[];
    };
    return project.tracks.find((t) => t.role === "dialogue")?.id;
  }, projectPath);
  expect(trackId).toBeTruthy();
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SuggestPendingEdit",
    { track_id: trackId, start: 4, end: 6, reason: "guest:suggest" },
    projectPath,
  );
}

/** The card's top and where the sticky ruler and marker lane end. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const bottoms = [".time-ruler", ".marker-lane"].flatMap((selector) => {
      const el = document.querySelector(selector);
      return el ? [el.getBoundingClientRect().bottom] : [];
    });
    return {
      barTop: document
        .querySelector(".pending-actionbar")
        ?.getBoundingClientRect().top as number,
      chromeBottom: Math.max(...bottoms),
    };
  });
}

async function expectCardBelowRuler(
  { page, browserName }: { page: Page; browserName: string },
  info: TestInfo,
  name: keyof typeof VIEWPORTS,
  theme: Theme,
): Promise<void> {
  test.setTimeout(40_000);
  await page.setViewportSize(VIEWPORTS[name]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  await suggestOnFirstDialogueTrack(page);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (name === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page
    .locator("[data-pending-id]")
    .last()
    .click({
      position: { x: 4, y: 4 },
    });
  const bar = page.locator(".pending-actionbar");
  await expect(bar).toBeVisible();
  await page.waitForTimeout(700);
  if ((await bar.getAttribute("class"))?.includes("--docked")) {
    save(info, `${browserName}-${name}-${theme}.png`, await page.screenshot());
    return;
  }
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(700);
  save(info, `${browserName}-${name}-${theme}.png`, await page.screenshot());
  const { barTop, chromeBottom } = await measure(page);
  expect(barTop).toBeGreaterThanOrEqual(chromeBottom - 0.5);
}

test("the pending action card stays below the sticky ruler: phone, light", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "phone", "light"));
test("the pending action card stays below the sticky ruler: phone, dark", ({
  page,
  browserName,
}, info) => expectCardBelowRuler({ page, browserName }, info, "phone", "dark"));
test("the pending action card stays below the sticky ruler: tablet, light", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "tablet", "light"));
test("the pending action card stays below the sticky ruler: tablet, dark", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "tablet", "dark"));
test("the pending action card stays below the sticky ruler: desktop, light", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "desktop", "light"));
test("the pending action card stays below the sticky ruler: desktop, dark", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "desktop", "dark"));
test("the pending action card stays below the sticky ruler: desktop-short, light", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "desktop-short", "light"));
test("the pending action card stays below the sticky ruler: desktop-short, dark", ({
  page,
  browserName,
}, info) =>
  expectCardBelowRuler({ page, browserName }, info, "desktop-short", "dark"));
