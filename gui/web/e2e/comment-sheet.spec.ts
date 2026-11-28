import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { inspectSelection, openProject, stageTab } from "./stageNav";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-comment-sheet-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function openPinComment(page: Page) {
  await postDocumentCommand(
    page,
    "e2e-comment-sheet",
    "AddComment",
    { body: "Tighten this open", author: "Ada", timeline_start: 5 },
    projectPath,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProject(page, projectPath);
  await page
    .locator('.sys-marker[data-kind="comment"] .sys-marker-hit')
    .click();
  await stageTab(page, "edit").click();
  // The pin is on screen, so its Action bar is not pinned away from it.
  await expect(
    page.getByRole("button", { name: /^Show (edit|selection)$/ }),
  ).toHaveCount(0);
  await inspectSelection(page);
  const card = page.locator("section.sys-inspector--popover");
  await expect(card.getByRole("heading", { name: "Comment" })).toBeVisible();
  await expect(card.getByText("Tighten this open")).toBeVisible();
  return card;
}

test("a pin-selected comment opens a usable comment popover at 1440", async ({
  page,
}) => {
  const card = await openPinComment(page);
  await expect
    .poll(async () => (await card.boundingBox())?.height ?? 0)
    .toBeGreaterThan(100);
  await expectPageAxeClean(page, ".sys-inspector");
  await card.getByRole("textbox", { name: "Reply to Ada" }).fill("On it");
  await card.getByRole("button", { name: "Reply" }).click();
  await expect(card.getByText("On it")).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(card.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("Escape leaves a comment draft unsent and restores Inspect focus", async ({
  page,
}) => {
  const card = await openPinComment(page);
  const reply = card.getByRole("textbox", { name: "Reply to Ada" });
  const inspect = page
    .getByRole("group", { name: /^(Selection|Edit) actions$/ })
    .getByRole("button", { name: "Inspect", exact: true });
  const writes: string[] = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"AddComment"'))
      writes.push(body);
  });

  await reply.fill("Unsent audit draft");
  await reply.press("Escape");
  await expect(reply).toHaveValue("Unsent audit draft");
  const close = card.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await close.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(inspect).toBeFocused();
  expect(writes).toEqual([]);
});
