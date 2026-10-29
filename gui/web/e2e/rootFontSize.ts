import { expect, type Page } from "@playwright/test";

/** Set the live page's root font size and wait until the browser reports it. */
export async function setRootFontSize(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.fontSize = `${value}px`;
  }, px);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    )
    .toBe(px);
}
