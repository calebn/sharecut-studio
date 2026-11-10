import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { openProject } from "./stageNav";
import {
  openScript,
  SCRIPT_SELECTED,
  SCRIPT_WORD,
  servePendingEditsCleared,
} from "./transcriptEdit";

/**
 * After a Script words cut, Tab selects the next occurrence and Backspace cuts
 * it, so the chain Tab, Backspace, Tab, Backspace runs to the last occurrence
 * with focus staying in the Script; the Tab after the last one is native.
 * The cuts are made on a disposable copy so no other spec sees them.
 */
let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-after-cut-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const focusInScript = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest(".sys-script-body") != null,
  );

test("Tab then Backspace walks every remaining occurrence with focus kept in the Script", async ({
  page,
}) => {
  await servePendingEditsCleared(page);
  await openProject(page, projectPath);
  const body = await openScript(page);
  const first = body.locator(SCRIPT_WORD).filter({ hasText: /^the$/ }).first();
  await first.click();
  await page.keyboard.press("Backspace");
  const toast = page.locator(".ui-toast-message");
  await expect(toast).toContainText(/Cut .* · \d+ more/);
  const remaining = Number(/(\d+) more/.exec(await toast.innerText())![1]);
  expect(remaining).toBeGreaterThan(1);
  await expect.poll(() => focusInScript(page)).toBe(true);

  const picked = page.locator(SCRIPT_SELECTED);
  for (let left = remaining; left > 0; left -= 1) {
    await page.keyboard.press("Tab");
    await expect(picked).toHaveCount(1);
    await expect(picked).toHaveText("the");
    await page.keyboard.press("Backspace");
    await expect(picked).toHaveCount(0);
    await expect.poll(() => focusInScript(page)).toBe(true);
  }

  await page.keyboard.press("Tab");
  await expect.poll(() => focusInScript(page)).toBe(false);
  await expect(picked).toHaveCount(0);
});
