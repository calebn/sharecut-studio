import type { Page } from "@playwright/test";

export type Theme = "light" | "dark";

/** Pin the app theme the way the Theme menu does (data-theme on <html>). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}
