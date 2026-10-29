import { expect, type Page } from "@playwright/test";

export async function rootFontSize(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
}

/** Set the live page's root font size and wait until the browser reports it. */
export async function setRootFontSize(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.fontSize = `${value}px`;
  }, px);
  await expect.poll(() => rootFontSize(page)).toBe(px);
}
