import { expect, type Locator, type Page } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openHostShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

export type Size = {
  name: string;
  width: number;
  height: number;
  touch: boolean;
};

export const SIZES = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
] as const;

export async function press(button: Locator, touch: boolean) {
  if (touch) {
    await button.tap();
  } else {
    await button.click();
  }
}

/** Every review request for the episode itself fails the way `fail` says. */
export async function failBootstrap(
  page: Page,
  token: string,
  fail:
    | "abort"
    | { status: number; headers?: Record<string, string>; body: string },
) {
  await page.route(`**/api/review/${token}/project`, (route) =>
    fail === "abort" ? route.abort("connectionrefused") : route.fulfill(fail),
  );
}

export async function withGuestLink(
  browser: Parameters<typeof withBrowserPages>[0],
  size: Size,
  run: (guest: Page, token: string) => Promise<void>,
) {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: size.width, height: size.height },
          hasTouch: size.touch,
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host!, projectPath);
        const token = await createReviewShare(host!, projectPath, "commenter");
        await run(guest!, token);
      },
    );
  });
}

/** A window too short for the cover's usual offset: a desktop at 200% zoom. */
export const SHORT_WINDOW = {
  name: "short",
  width: 640,
  height: 400,
  touch: false,
} as const;

/** The cover's title, sentence and whole button sit inside the window and the page does not scroll. */
export async function expectCoverInWindow(page: Page) {
  const fit = await page.evaluate(() => {
    const parts = ["main h1", ".sys-cover-text", "main button"].map((sel) => {
      const box = document.querySelector(sel)!.getBoundingClientRect();
      return { sel, top: box.top, bottom: box.bottom };
    });
    return {
      outside: parts.filter((p) => p.top < 0 || p.bottom > window.innerHeight),
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(fit.outside, JSON.stringify(fit)).toEqual([]);
  expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
}
