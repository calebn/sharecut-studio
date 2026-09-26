import { type Browser, expect, type Page } from "@playwright/test";
import { clickHTMLElement } from "./domClick";
import { e2eProjectPath } from "./env";
import { openHostShare } from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

const FOLLOW_BANNER_TRANSITION_TIMEOUT_MS = 1_000;

/** Wait for React to render the banner after a synchronous follow command. */
export async function waitForFollowBanner(follower: Page): Promise<boolean> {
  try {
    await follower.locator(".follow-banner").waitFor({
      state: "visible",
      timeout: FOLLOW_BANNER_TRANSITION_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return false;
    }
    throw error;
  }
}

export async function withTwoHostPages<T>(
  browser: Browser,
  viewport: { width: number; height: number },
  run: (pageA: Page, pageB: Page) => Promise<T>,
): Promise<T> {
  const projectPath = e2eProjectPath;
  return withTwoBrowserPages(
    browser,
    { viewport },
    { viewport },
    async (pageA, pageB) => {
      await openHostShare(pageA, projectPath);
      await openHostShare(pageB, projectPath);
      return run(pageA, pageB);
    },
  );
}

export async function followUntilBannerVisible(
  follower: Page,
  openMenu: () => Promise<void>,
): Promise<void> {
  await openMenu();
  const menuItems = follower.getByRole("menuitem", { name: /Follow/ });
  const isCompactShell = (follower.viewportSize()?.width ?? 0) < 768;
  if (isCompactShell) {
    // Collapsed shells (tablet/phone menu) list peers in the People section.
    await expect(menuItems.first()).toBeVisible({ timeout: 15_000 });
    const n = await menuItems.count();
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        await openMenu();
      }
      await clickHTMLElement(menuItems.nth(i));
      if (await waitForFollowBanner(follower)) {
        return;
      }
    }
    throw new Error("no Follow peer showed a banner");
  }
  // Desktop transport isn't collapsed: peers are avatar-stack buttons.
  await follower.keyboard.press("Escape");
  const buttons = follower.getByRole("button", { name: /^Follow / });
  await expect(buttons.first()).toBeVisible({ timeout: 15_000 });
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    await buttons.nth(i).click();
    if (await waitForFollowBanner(follower)) {
      return;
    }
  }
  throw new Error("no Follow peer showed a banner");
}
