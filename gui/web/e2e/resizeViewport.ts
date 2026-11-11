import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __viewportResized?: Promise<void>;
  }
}

/**
 * setViewportSize can resolve before the page's resize event runs, so wait for
 * the event; skip it when the viewport already has the size (no event fires).
 */
export async function resizeViewport(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  const current = page.viewportSize();
  if (current?.width === size.width && current.height === size.height) return;
  await page.evaluate(() => {
    window.__viewportResized = new Promise((resolve) =>
      window.addEventListener("resize", () => resolve(), { once: true }),
    );
  });
  await page.setViewportSize(size);
  await page.evaluate(() => window.__viewportResized);
}
