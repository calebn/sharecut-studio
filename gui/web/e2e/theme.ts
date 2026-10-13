import type { Page } from "@playwright/test";

export type Theme = "light" | "dark";
export type Appearance = { theme: Theme; reducedMotion: boolean };

const APPEARANCES: readonly Appearance[] = [
  { theme: "light", reducedMotion: false },
  { theme: "dark", reducedMotion: true },
  { theme: "light", reducedMotion: true },
  { theme: "dark", reducedMotion: false },
];

/**
 * Give each geometry cell (viewport, root size, orientation) one appearance
 * instead of crossing it with theme and motion. Theme only changes color
 * tokens and motion only changes animation, so a layout assertion needs every
 * boundary cell once, not once per appearance. Two cells already run both
 * themes and both motion settings, and four cells run every pairing. Each
 * further block of four shifts the cycle by one, so a second axis never lines
 * up with the theme. A check that reads color (axe contrast) loops over the
 * themes itself and is named in `gridBoundary.test.ts`.
 */
export function withAppearance<T>(
  cells: readonly T[],
  offset = 0,
): (Appearance & { cell: T })[] {
  return cells.map((cell, index) => ({
    cell,
    ...APPEARANCES[(index + Math.floor(index / 4) + offset) % 4]!,
  }));
}

/** Pin the app theme the way the Theme menu does (data-theme on <html>). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
}
