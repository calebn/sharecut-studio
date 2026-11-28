import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import { openProject, phone } from "./stageNav";
import {
  openScript,
  SCRIPT_SELECTED,
  withDocumentCommandTypes,
} from "./transcriptEdit";

for (const { width, height, touch } of [
  { width: 1280, height: 800, touch: false },
  { width: 320, height: 568, touch: true },
]) {
  test.describe(`${width}px Script`, () => {
    test.use({ viewport: { width, height }, hasTouch: touch });

    test("clears selected words without altering the saved transcript", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await openProject(page, projectPath);
        if (touch) await phone.showText(page);
        const script = await openScript(page);
        const word = script
          .getByRole("button", { name: /^my(?: \(.*\))?$/ })
          .first();
        const clear = page.getByRole("button", {
          name: "Clear selection",
          exact: true,
        });
        const actions = page.getByRole("group", {
          name: "Selection actions",
          exact: true,
        });
        const field = script.getByRole("textbox", {
          name: "Fix text",
          exact: true,
        });

        await withDocumentCommandTypes(page, async (commands) => {
          await expect(clear).toHaveCount(0);
          if (touch) await word.tap();
          else await word.click();
          await expect(word).toHaveAttribute("data-selected");
          if (!touch) await expect(actions).toBeVisible();
          await expect(clear).toHaveText("Clear selection");
          if (touch) {
            const tip = page
              .getByRole("note")
              .filter({ hasText: "Drag the handles to adjust" });
            await expect(tip).toBeVisible();
            await clear.tap({ trial: true });
            const enlarged = await page.addStyleTag({
              content: "html { font-size: 200%; }",
            });
            await expect(tip).toHaveCount(0);
            await expect(clear).toBeInViewport({ ratio: 1 });
            const bounds = await clear.boundingBox();
            expect(bounds?.width).toBeGreaterThanOrEqual(44);
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
            await clear.tap();
            await enlarged.evaluate((node) =>
              node.parentNode?.removeChild(node),
            );
          } else {
            await clear.focus();
            await clear.press("Enter");
          }
          await expect(script.locator(SCRIPT_SELECTED)).toHaveCount(0);
          await expect(actions).toHaveCount(0);
          await expect(clear).toHaveCount(0);
          await expect(word).toBeFocused();
          expect(commands).toEqual([]);

          if (touch) await word.tap();
          else await word.click();
          await expect(clear).toBeVisible();
          await word.press("F2");
          await expect(field).toBeFocused();
          await expect(clear).toHaveCount(0);
          await field.fill("not saved");
          await field.press("Escape");
          await expect(field).toHaveCount(0);
          await expect(word).toBeFocused();
          expect(commands).toEqual([]);

          await word.press("F2");
          await field.fill("My");
          await field.press("Enter");
          const corrected = script
            .getByRole("button", { name: /^My(?: \(.*\))?$/ })
            .first();
          const fixedCard = page
            .locator(".ui-toast")
            .filter({ hasText: "Text fixed: My" });
          const dismiss = fixedCard.getByRole("button", {
            name: "Dismiss",
            exact: true,
          });
          await expect(corrected).toHaveAttribute("data-selected");
          await expect(fixedCard).toBeVisible();
          if (touch) await dismiss.tap();
          else await dismiss.click();
          await expect(fixedCard).toHaveCount(0);
          await expect(corrected).toBeVisible();
          await expect(corrected).toHaveAttribute("data-selected");
          await expect(clear).toBeVisible();
          await expectPageAxeClean(page, ".sys-script-header");
          if (touch) await clear.tap();
          else await clear.click();
          await expect(script.locator(SCRIPT_SELECTED)).toHaveCount(0);
          await expect(corrected).toBeFocused();
          expect(commands).toEqual(["CorrectTranscriptWord"]);

          await page.reload();
          await expect(page.getByRole("heading", { level: 1 })).toContainText(
            /aligned dialogue/i,
          );
          if (touch) await phone.showText(page);
          await openScript(page);
          await expect(corrected).toBeVisible();
        });
      });
    });
  });
}
