import type { Locator, Page } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openHostShare } from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

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
  size: (typeof SIZES)[number],
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
