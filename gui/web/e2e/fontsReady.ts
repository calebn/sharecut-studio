import { expect, type Page } from "@playwright/test";

/**
 * Waits until every web font the page asked for has arrived. A button that is
 * visible may still be drawn in the fallback font, and measuring it before the
 * swap gives a width and position that change on their own a moment later.
 * Call it once the text is on screen (the page has asked for its fonts by
 * then) and before the first bounding box is read.
 */
export async function fontsReady(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.status;
      }),
    )
    .toBe("loaded");
}
