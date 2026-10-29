import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { newFinger } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { switchE2eProject } from "../e2e/shareableProject";
import { inspectSelectionByKey, openProject } from "../e2e/stageNav";
import { buildFixture, centerOf, lane, setZoom } from "../e2e/touchTimeline";

// A mouse window: a coarse pointer at this size gets the Inspector column
// (#1696), and the compact strip is what hands its card to the regular sheet.
test.use({ hasTouch: false });
let projectPath: string;
let workspaceDir: string;
test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-pending-lifecycle-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});
async function open(page: Page) {
  await page.setViewportSize({ width: 844, height: 390 });
  await openProject(page, projectPath);
  await page.evaluate(() =>
    localStorage.setItem("sharecut.compactInspector", "peek"),
  );
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await setZoom(page, 3);
}
async function selected(
  page: Page,
  context: BrowserContext,
  browserName: string,
) {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, "e2e-pending-lifecycle");
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const at = await centerOf(page, `${lane} [data-pending-id] >> nth=0`);
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await inspectSelectionByKey(page);
  await expect(page.locator(".pending-actionbar--docked")).toBeVisible();
  await page.waitForTimeout(700);
}
test("live waiver draft survives a short to tall tablet resize", async ({
  page,
  context,
  browserName,
}, info) => {
  await selected(page, context, browserName);
  await page.route("**/api/document/command**", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === "ApproveEdits")
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
        body: JSON.stringify({
          detail: "Transcript refinement is required before approval.",
        }),
      });
    else await route.continue();
  });
  const bar = page.locator(".pending-actionbar");
  await bar.getByRole("button", { name: "Approve", exact: true }).click();
  const reason = bar.getByRole("textbox", { name: "Waiver reason" });
  await expect(reason).toBeVisible();
  await reason.fill("Reviewed every flagged transcript word");
  await reason.focus();
  await page.setViewportSize({ width: 844, height: 900 });
  await expect(
    page.locator(".bottom-sheet--compact .pending-actionbar--docked"),
  ).toBeVisible();
  await page.waitForTimeout(700);
  const moved = page
    .locator(".pending-actionbar")
    .getByRole("textbox", { name: "Waiver reason" });
  const actual = await moved.inputValue();
  await info.attach("relocation", {
    body: JSON.stringify({
      browserName,
      actual,
      focus: await page.evaluate(() => document.activeElement?.tagName),
    }),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("waiver-transition.png") });
  await expect(moved).toHaveValue("Reviewed every flagged transcript word");
  await expect(moved).toBeFocused();
});
