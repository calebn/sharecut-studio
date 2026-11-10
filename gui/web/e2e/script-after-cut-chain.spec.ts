import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import { openScript, SCRIPT_SELECTED, SCRIPT_WORD } from "./transcriptEdit";

/**
 * After a Script words cut, Tab selects the next occurrence and Backspace cuts
 * it, so the chain Tab, Backspace, Tab, Backspace runs to the last occurrence
 * with focus staying in the Script; the Tab after the last one is native.
 */
const focusInScript = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest(".sys-script-body") != null,
  );

test("Tab then Backspace walks every remaining occurrence with focus kept in the Script", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const body = await openScript(page);
  const words = body.locator(SCRIPT_WORD);
  await expect(words.nth(17)).toHaveText("the");
  await words.nth(17).click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".ui-toast-message")).toContainText("Cut ");
  await expect.poll(() => focusInScript(page)).toBe(true);

  let cuts = 0;
  for (;;) {
    await page.keyboard.press("Tab");
    const picked = page.locator(SCRIPT_SELECTED);
    if ((await picked.count()) === 0) break;
    await expect(picked.first()).toHaveText("the");
    await page.keyboard.press("Backspace");
    cuts += 1;
    await expect(picked).toHaveCount(0);
    await expect.poll(() => focusInScript(page)).toBe(true);
  }
  expect(cuts).toBe(3);
  expect(await focusInScript(page)).toBe(false);
});
