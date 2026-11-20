import { expect, type Page } from "@playwright/test";

/**
 * Waits until every web font the page asked for has arrived. A button that is
 * visible may still be drawn in the fallback font, and measuring it before the
 * swap gives a width and position that change on their own a moment later.
 * Call it once the text is on screen and before the first bounding box is
 * read. It first waits for the page's stylesheets, because the page asks for
 * no font until its styles apply.
 */
export async function fontsReady(page: Page) {
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]"),
    ].every((link) => link.sheet !== null),
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        // Two frames: the fonts the styles name are asked for at the first
        // layout after the sheet applies.
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        await document.fonts.ready;
        return document.fonts.status;
      }),
    )
    .toBe("loaded");
}
