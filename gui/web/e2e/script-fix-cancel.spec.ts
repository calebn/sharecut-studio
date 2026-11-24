import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import { openProject, phone } from "./stageNav";
import { openScript, withDocumentCommandTypes } from "./transcriptEdit";

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-fix-cancel-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const LAYOUTS = [
  { name: "1280x800 mouse", width: 1280, height: 800, touch: false },
  { name: "820x1180 touch", width: 820, height: 1180, touch: true },
  { name: "390x844 touch", width: 390, height: 844, touch: true },
  { name: "320x568 touch", width: 320, height: 568, touch: true },
];

async function press(target: Locator, touch: boolean) {
  if (touch) await target.tap();
  else await target.click();
}

async function openFix(page: Page, touch: boolean) {
  await openProject(page, projectPath);
  if (touch && page.viewportSize()!.width < 500) await phone.showText(page);
  const script = await openScript(page);
  const word = script.locator(".sys-script-word").nth(2);
  await press(word, touch);
  await word.press("F2");
  const field = script.getByRole("textbox", { name: /^Fix text/ });
  await expect(field).toBeFocused();
  return { script, word, field };
}

async function expectCancelReachable(cancel: Locator, touch: boolean) {
  await expect(cancel).toBeInViewport({ ratio: 1 });
  if (!touch) return;
  const box = await cancel.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

for (const { name, width, height, touch } of LAYOUTS) {
  test.describe(`Fix text Cancel at ${name}`, () => {
    test.use({ viewport: { width, height }, hasTouch: touch });

    test("Cancel discards the typing, saves nothing and refocuses the word", async ({
      page,
    }) => {
      const { script, word, field } = await openFix(page, touch);
      const before = await word.textContent();
      await withDocumentCommandTypes(page, async (commands) => {
        await field.fill("not saved");
        const cancel = script.getByRole("button", {
          name: "Cancel fix",
          exact: true,
        });
        await expectCancelReachable(cancel, touch);
        await press(cancel, touch);
        await expect(field).toHaveCount(0);
        await expect(word).toBeFocused();
        await expect(word).toHaveText(before ?? "");
        await expect(page.locator(".ui-toast")).toHaveCount(0);
        expect(commands).toEqual([]);
      });
    });

    test("a tap outside still saves once, and Undo restores", async ({
      page,
    }) => {
      const { script, field } = await openFix(page, touch);
      await withDocumentCommandTypes(page, async (commands) => {
        await field.fill("Saved");
        await press(script.locator(".sys-script-word").nth(5), touch);
        const toast = page
          .locator(".ui-toast")
          .filter({ hasText: "Text fixed" });
        await expect(toast).toBeVisible();
        expect(commands).toEqual(["CorrectTranscriptWord"]);
        await press(
          toast.getByRole("button", { name: "Undo", exact: true }),
          touch,
        );
        await expect(
          script.getByRole("button", { name: /^Saved\b/ }),
        ).toHaveCount(0);
      });
    });
  });
}

test.describe("Fix text Cancel at 200% text", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("stays in view and 44 px", async ({ page }) => {
    const { script, word, field } = await openFix(page, true);
    const enlarged = await page.addStyleTag({
      content: "html { font-size: 200%; }",
    });
    await field.fill("not saved");
    const cancel = script.getByRole("button", {
      name: "Cancel fix",
      exact: true,
    });
    await expectCancelReachable(cancel, true);
    await cancel.tap();
    await expect(field).toHaveCount(0);
    await expect(word).toBeFocused();
    await enlarged.evaluate((node) => node.parentNode?.removeChild(node));
  });
});
