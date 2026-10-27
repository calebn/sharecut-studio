import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import {
  chromeBoxes,
  expectHitTestable,
  settle,
  suggestOnFirstDialogueTrack,
} from "../e2e/pendingActionbar";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";
import { setTheme, type Theme, withAppearance } from "../e2e/theme";
import { save } from "../e2e/touchTimeline";

const CLIENT_ID = "e2e-actionbar-ruler";
type Outcome = "docked" | "floating" | "inline";

/**
 * Where the review actions end up: docked in the compact sheet, on the phone
 * and the tablet alike; floating between the sticky ruler and the bottom panel; or, when the card
 * cannot fit between ruler and panel, left to the inspector's inline controls.
 */
const VIEWPORTS: Record<
  string,
  { width: number; height: number; outcome: Outcome }
> = {
  phone: { width: 360, height: 800, outcome: "docked" },
  "tablet-short": { width: 768, height: 500, outcome: "docked" },
  tablet: { width: 820, height: 1180, outcome: "docked" },
  "tablet-768": { width: 768, height: 1024, outcome: "docked" },
  "tablet-landscape-1194": {
    width: 1194,
    height: 820,
    outcome: "docked",
  },
  "desktop-1195": { width: 1195, height: 820, outcome: "floating" },
  "desktop-500": { width: 1280, height: 500, outcome: "floating" },
  "desktop-short": { width: 1280, height: 440, outcome: "inline" },
};

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

async function seedMarkersAndSuggestion(page: Page): Promise<void> {
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddChapter",
    { time: 15, title: "Ruler chapter" },
    projectPath,
  );
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddComment",
    {
      body: "Ruler comment",
      author: "Playwright",
      timeline_start: 25,
      timeline_end: 28,
    },
    projectPath,
  );
  await suggestOnFirstDialogueTrack(page, projectPath, CLIENT_ID);
}

async function expectCardOutcome(
  { page, browserName }: { page: Page; browserName: string },
  info: TestInfo,
  name: string,
  theme: Theme,
): Promise<void> {
  test.setTimeout(40_000);
  const { outcome, ...size } = VIEWPORTS[name];
  await page.setViewportSize(size);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await seedMarkersAndSuggestion(page);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  if (name === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page
    .locator("[data-pending-id]")
    .last()
    .click({
      position: { x: 4, y: 4 },
    });
  const bar = page.locator(".pending-actionbar");
  await expect(bar).toBeAttached();
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settle(page);
  save(info, `${browserName}-${name}-${theme}.png`, await page.screenshot());

  if (outcome === "docked") {
    await expect(bar).toHaveClass(/pending-actionbar--docked/);
    expect(
      await bar.evaluate((el) => ({
        inspectorSheet: el.closest(".bottom-sheet--inspector") !== null,
        compactSheet: el.closest(".bottom-sheet--compact") !== null,
      })),
    ).toEqual({ inspectorSheet: true, compactSheet: true });
    await expectHitTestable(bar.getByRole("button", { name: "Approve" }));
    await expectHitTestable(bar.getByRole("button", { name: "Reject" }));
    return;
  }
  await expect(bar).not.toHaveClass(/pending-actionbar--docked/);
  if (outcome === "inline") {
    await expect(bar).toBeHidden();
    await expectHitTestable(page.getByRole("button", { name: "Approve" }));
    await expectHitTestable(page.getByRole("button", { name: "Reject" }));
    return;
  }
  await expect(bar).toBeVisible();
  const { top, bottom } = await bar.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  const { ruler, marker, panel } = await chromeBoxes(page);
  expect(top).toBeGreaterThanOrEqual(
    Math.max(ruler.bottom, marker.bottom) - 0.5,
  );
  expect(bottom).toBeLessThanOrEqual(panel.top + 0.5);
  await expectHitTestable(bar.getByRole("button", { name: "Approve" }));
  await expectHitTestable(bar.getByRole("button", { name: "Reject" }));
}

const appearances = new Map(
  withAppearance(Object.keys(VIEWPORTS)).map(({ cell, theme }) => [
    cell,
    theme,
  ]),
);

function named(outcome: Outcome): string[] {
  return Object.keys(VIEWPORTS).filter(
    (name) => VIEWPORTS[name].outcome === outcome,
  );
}

function run(name: string) {
  return (
    { page, browserName }: { page: Page; browserName: string },
    info: TestInfo,
  ) =>
    expectCardOutcome(
      { page, browserName },
      info,
      name,
      appearances.get(name)!,
    );
}

for (const name of named("docked")) {
  test.describe(`pending actions at ${name}`, () => {
    test("docks in the inspector sheet", run(name));
  });
}
for (const name of named("floating")) {
  test.describe(`pending actions at ${name}`, () => {
    test("floats between the ruler and the bottom panel", run(name));
  });
}
for (const name of named("inline")) {
  test.describe(`pending actions at ${name}`, () => {
    test("leaves Approve and Reject to the inspector", run(name));
  });
}
