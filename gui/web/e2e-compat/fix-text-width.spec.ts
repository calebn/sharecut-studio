import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { openProject } from "../e2e/stageNav";
import { openScript } from "../e2e/transcriptEdit";

test("Fix text fallback fits wide text and stays within its row", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const script = await openScript(page);
  const word = script.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first();
  await word.focus();
  await page.keyboard.press("F2");
  const input = script.getByRole("textbox", { name: "Fix text" });
  await expect(input).toBeFocused();

  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
          const rule = sheet.cssRules[index];
          if (
            rule instanceof CSSSupportsRule &&
            rule.conditionText.includes("field-sizing")
          ) {
            sheet.deleteRule(index);
          }
        }
      } catch {
        continue;
      }
    }
  });

  await input.fill("W".repeat(12));
  const wideText = await input.evaluate((element) => ({
    clipped: element.scrollWidth > element.clientWidth,
    inputWidth: element.getBoundingClientRect().width,
    rowWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
    availableWidth:
      element.parentElement?.parentElement?.getBoundingClientRect().width ?? 0,
  }));
  expect(wideText.clipped).toBe(false);
  expect(wideText.inputWidth).toBeLessThanOrEqual(wideText.rowWidth);
  expect(wideText.rowWidth).toBeLessThanOrEqual(wideText.availableWidth);

  await input.fill("W".repeat(6));
  const narrowWidth = await input.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(narrowWidth).toBeLessThan(wideText.inputWidth);

  await input.fill("W".repeat(12));
  await input.press("End");
  await input.press("Backspace");
  const deletedWidth = await input.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(deletedWidth).toBeLessThan(wideText.inputWidth);

  await input.fill("");
  await expect(input).toBeFocused();
  const emptyWidth = await input.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(emptyWidth).toBeGreaterThanOrEqual(48);
  expect(emptyWidth).toBeLessThan(wideText.inputWidth);
  await input.press("Escape");
  await expect(input).toHaveCount(0);
});
