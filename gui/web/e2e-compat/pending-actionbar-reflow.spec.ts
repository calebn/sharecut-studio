import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import {
  type Box,
  chromeBoxes,
  expectHitTestable,
  isHitTestable,
  settle,
  suggestOnFirstDialogueTrack,
} from "../e2e/pendingActionbar";
import { switchE2eProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

const CLIENT_ID = "e2e-actionbar-reflow";
const REFINE_GATE =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine (whole-episode pass), then `podcast transcript refine-waive --reason ...` / transcript_refine_waive_tool.";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-actionbar-reflow-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function openWithSuggestion(page: Page): Promise<void> {
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddChapter",
    { time: 15, title: "Reflow chapter" },
    projectPath,
  );
  await suggestOnFirstDialogueTrack(page, projectPath, CLIENT_ID);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await page
    .locator("[data-pending-id]")
    .last()
    .click({ position: { x: 4, y: 4 } });
  await expect(page.locator(".pending-actionbar")).toBeVisible();
}

async function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  });
}

async function cardTop(page: Page): Promise<number> {
  return (await boxOf(page.locator(".pending-actionbar"))).top;
}

/**
 * Scrolls the inspector the way a pointer user does, with the wheel over it:
 * `scrollIntoView` would also scroll the shell, which a pointer cannot.
 */
async function scrollInspectorToReach(
  page: Page,
  inspector: Locator,
  button: Locator,
): Promise<void> {
  const box = await inspector.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 4);
  for (let step = 0; step < 20 && !(await isHitTestable(button)); step++) {
    await page.mouse.wheel(0, 120);
    await settle(page);
  }
}

test("pending card: a marker lane that grows while it floats moves the card clear of the lane", async ({
  page,
}) => {
  test.setTimeout(40_000);
  await page.setViewportSize({ width: 1280, height: 540 });
  await openWithSuggestion(page);
  await settle(page);
  const before = await chromeBoxes(page);
  expect(await cardTop(page)).toBeGreaterThanOrEqual(
    Math.max(before.ruler.bottom, before.marker.bottom) - 0.5,
  );

  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddComment",
    {
      body: "Marker lane grows",
      author: "Playwright",
      timeline_start: 25,
      timeline_end: 28,
    },
    projectPath,
  );
  await expect
    .poll(async () => (await chromeBoxes(page)).marker.bottom)
    .toBeGreaterThan(before.marker.bottom + 1);

  // No scroll and no resize since the lane grew: the card must follow the
  // lane's floor and keep clear of the region the lane pushed down.
  await expect
    .poll(async () => {
      const { ruler, marker } = await chromeBoxes(page);
      const card = await boxOf(page.locator(".pending-actionbar"));
      const region = await boxOf(page.locator(".pending-overlay.selected"));
      return {
        belowChrome: card.top >= Math.max(ruler.bottom, marker.bottom) - 0.5,
        clearOfRegion:
          card.top >= region.bottom - 0.5 || card.bottom <= region.top + 0.5,
      };
    })
    .toEqual({ belowChrome: true, clearOfRegion: true });
});

test("pending review: the inspector's inline Approve and Reject stay reachable after approving at 720 and shrinking to 260", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.route("**/api/document/command**", async (route) => {
    const body = route.request().postDataJSON() as { type?: string } | null;
    if (body?.type === "ApproveEdits") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
        body: JSON.stringify({ detail: REFINE_GATE }),
      });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openWithSuggestion(page);
  await page
    .locator(".pending-actionbar")
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(page.getByRole("alert").first()).toBeVisible();

  // The stage frame has no bottom panel, so the card only loses its room
  // between the marker lane and the Player at about this height.
  await page.setViewportSize({ width: 1280, height: 260 });
  await settle(page);
  await expect(page.locator(".pending-actionbar")).toBeHidden();

  const inspector = page.locator(".modifier-inspector");
  for (const name of ["Approve", "Reject"]) {
    const button = inspector.getByRole("button", { name, exact: true });
    await scrollInspectorToReach(page, inspector, button);
    await expectHitTestable(button);
  }
  expect(
    await page.locator(".stage-frame").evaluate((el) => el.scrollTop),
    "the shell itself never scrolls",
  ).toBe(0);
});
