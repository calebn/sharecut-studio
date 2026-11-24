import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { openScript, withDocumentCommandTypes } from "./transcriptEdit";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-toast-touch-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const toastOf = (page: Page) =>
  page.locator(".ui-toast").filter({ hasText: "Text fixed" });

for (const { name, width, height } of [
  { name: "desktop with touch", width: 1280, height: 800 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
]) {
  test.describe(`Toast buttons at ${name}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true });

    test("Dismiss and Undo are 44 px, and Dismiss leaves the correction", async ({
      page,
    }) => {
      await openProject(page, projectPath);
      const script = await openScript(page);
      await withDocumentCommandTypes(page, async (commands) => {
        for (const text of ["Zed", "Yan"]) {
          const word = script.locator(".sys-script-word").nth(2);
          await word.tap();
          await word.press("F2");
          const field = script.getByRole("textbox", { name: /^Fix text/ });
          await field.fill(text);
          await field.press("Enter");
          const toast = toastOf(page);
          await expect(toast).toBeVisible();
          for (const label of ["Dismiss", "Undo"]) {
            const box = await toast
              .getByRole("button", { name: label, exact: true })
              .boundingBox();
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box?.height).toBeGreaterThanOrEqual(44);
          }
          await toast
            .getByRole("button", { name: "Dismiss", exact: true })
            .tap();
          await expect(toast).toHaveCount(0);
          await expect(
            script.getByRole("button", { name: new RegExp(`^${text}\\b`) }),
          ).toBeVisible();
        }
        expect(commands).toEqual([
          "CorrectTranscriptWord",
          "CorrectTranscriptWord",
        ]);
      });
    });
  });
}
