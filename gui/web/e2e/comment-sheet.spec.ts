import { expect, test } from "@playwright/test";
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

test("a pin-selected comment opens a usable Inspector card at 1440", async ({
  page,
}) => {
  await postDocumentCommand(
    page,
    "e2e-comment-sheet",
    "AddComment",
    { body: "Tighten this open", author: "Ada", timeline_start: 5 },
    projectPath,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProject(page, projectPath);
  await page.locator(".comment-marker.pin").click();
  await stageTab(page, "edit").click();
  await inspectSelection(page);
  const card = page.locator("section.sys-inspector--card");
  await expect(card.getByRole("heading", { name: "Comment" })).toBeVisible();
  await expect(card.getByText("Tighten this open")).toBeVisible();
  const box = await card.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(100);
  await expectPageAxeClean(page, ".sys-inspector");
  await card.getByRole("textbox", { name: "Reply to comment" }).fill("On it");
  await card.getByRole("button", { name: "Reply" }).click();
  await expect(card.getByText("On it")).toBeVisible();
  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(card.getByRole("button", { name: "Reopen" })).toBeVisible();
});
