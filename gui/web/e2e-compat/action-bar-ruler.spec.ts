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
  selectionBar,
  settle,
  suggestOnFirstDialogueTrack,
} from "../e2e/pendingActionbar";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";
import { setTheme, type Theme, withAppearance } from "../e2e/theme";
import { save } from "../e2e/touchTimeline";

const CLIENT_ID = "e2e-actionbar-ruler";
type Outcome = "docked" | "floating" | "cramped";

/**
 * Where the review actions end up: docked above the compact sheet on the phone;
 * floating between the sticky ruler and the bottom panel; or, when the screen
 * is too short for both, floating over the panel with the verbs still reachable.
 */
const VIEWPORTS: Record<
  string,
  { width: number; height: number; outcome: Outcome }
> = {
  phone: { width: 360, height: 800, outcome: "docked" },
  "tablet-short": { width: 768, height: 500, outcome: "floating" },
  tablet: { width: 820, height: 1180, outcome: "floating" },
  "tablet-768": { width: 768, height: 1024, outcome: "floating" },
  "tablet-landscape-1194": {
    width: 1194,
    height: 820,
    outcome: "floating",
  },
  "desktop-1195": { width: 1195, height: 820, outcome: "floating" },
  "desktop-360": { width: 1280, height: 360, outcome: "floating" },
  "desktop-500": { width: 1280, height: 500, outcome: "floating" },
  "desktop-short": { width: 1280, height: 220, outcome: "cramped" },
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
  const bar = selectionBar(page);
  await expect(bar).toBeVisible();
  if (outcome !== "cramped")
    await page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await settle(page);
  save(info, `${browserName}-${name}-${theme}.png`, await page.screenshot());

  if (outcome === "docked") {
    await expect(bar).toHaveClass(/sys-actions--dock/);
  } else {
    await expect(bar).toHaveClass(/sys-actions--floating/);
    const { top, bottom } = await bar.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const { ruler, marker, panel } = await chromeBoxes(page);
    expect(top).toBeGreaterThanOrEqual(
      Math.max(ruler.bottom, marker.bottom) - 0.5,
    );
    if (outcome === "floating")
      expect(bottom).toBeLessThanOrEqual(panel.top + 0.5);
  }
  await expectHitTestable(
    bar.getByRole("button", { name: "Approve", exact: true }),
  );
  await expectHitTestable(
    bar.getByRole("button", { name: "Reject", exact: true }),
  );
}

const appearances = new Map(
  withAppearance(Object.keys(VIEWPORTS)).map(({ cell, theme }) => [
    cell,
    theme,
  ]),
);

function run(name: string) {
  return async (
    { page, browserName }: { page: Page; browserName: string },
    info: TestInfo,
  ) => {
    await expectCardOutcome(
      { page, browserName },
      info,
      name,
      appearances.get(name)!,
    );
  };
}

for (const name of Object.keys(VIEWPORTS)) {
  test.describe(`pending actions at ${name}`, () => {
    test(
      "the Action bar keeps Approve and Reject reachable beside the selection",
      run(name),
    );
  });
}
