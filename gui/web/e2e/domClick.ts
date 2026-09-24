import type { Locator } from "@playwright/test";

/** Click an HTML control in-page when Playwright's pointer action is obstructed. */
export async function clickHTMLElement(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("expected an HTML control to click");
    }
    element.click();
  });
}
