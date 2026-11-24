import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { goToStage, openProject, phone } from "./stageNav";
import { withDocumentCommandTypes } from "./transcriptEdit";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-dock-close-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const sheetOf = (page: Page) =>
  page.getByRole("dialog", { name: "Inspector", exact: true });

async function openAtDock(page: Page): Promise<{
  clip: Locator;
  opener: Locator;
  sheet: Locator;
}> {
  const clip = page.locator(".clip-hit").first();
  await clip.tap();
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  const opener = page
    .getByRole("group", { name: "Edit actions" })
    .getByRole("button", { name: "Inspect", exact: true });
  await opener.tap();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  const grip = sheet.getByRole("slider", { name: "Sheet height" });
  await grip.focus();
  await grip.press("Home");
  await expect(grip).toHaveAttribute("aria-valuetext", "Dock");
  return { clip, opener, sheet };
}

for (const { width, height } of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 360, height: 640 },
]) {
  test.describe(`${width}x${height} phone`, () => {
    test.use({
      viewport: { width, height },
      hasTouch: true,
      reducedMotion: "reduce",
    });

    test("Close sits in view at the dock detent and hides the sheet, keeping the selection", async ({
      page,
    }) => {
      await openProject(page, projectPath);
      await goToStage(page, "edit");
      await phone.showTimeline(page);
      await withDocumentCommandTypes(page, async (commands) => {
        for (let round = 0; round < 2; round += 1) {
          const { clip, opener, sheet } = await openAtDock(page);
          const close = sheet.getByRole("button", {
            name: "Close",
            exact: true,
          });
          await expect(close).toHaveCount(1);
          await expect(close).toBeInViewport({ ratio: 1 });
          const bounds = await close.boundingBox();
          expect(bounds?.width).toBeGreaterThanOrEqual(44);
          expect(bounds?.height).toBeGreaterThanOrEqual(44);
          await close.tap();
          await expect(sheet).toHaveCount(0);
          await expect(clip).toHaveAttribute("aria-pressed", "true");
          await expect(opener).toBeFocused();
          expect(commands).toEqual([]);
        }
      });
    });
  });
}
