import { type Browser, expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { waitForFollowBanner } from "./followBanner";
import {
  expectMenuLastItemReachable,
  expectShareRecordRoomsReachable,
  openTransportMenu,
  SHORT_VIEWPORTS,
} from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import {
  openGuestShare,
  openHostShare,
  PROXY_MANIFEST_TIMEOUT_MS,
} from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

async function withTwoHostPages<T>(
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

async function followUntilBannerVisible(
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
      await menuItems.nth(i).evaluate((el) => el.click());
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

test.describe("overlay with follow banner", () => {
  for (const viewport of SHORT_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    test(`menu last item and Share rooms stay reachable at ${label}`, async ({
      browser,
    }) => {
      await withTwoHostPages(browser, viewport, async (_pageA, pageB) => {
        await followUntilBannerVisible(pageB, async () => {
          await openTransportMenu(pageB);
        });
        await expect(pageB.locator(".follow-banner")).toBeVisible();
        // The banner row above the transport shrinks --menu-available-height;
        // the menu must still fit and keep its last item reachable, and Share's
        // Record rooms must stay reachable through the dialog scroller.
        // Keep it open to cover callers that enter this check after a Follow click.
        await openTransportMenu(pageB);
        await expectMenuLastItemReachable(pageB);
        await expectShareRecordRoomsReachable(pageB);
      });
    });
  }
});

test.describe("overlay with guest and follow banners", () => {
  for (const viewport of [
    { width: 1280, height: 715 },
    { width: 390, height: 844 },
  ]) {
    test(`menu last item stays reachable with stacked banners at ${viewport.width}x${viewport.height}`, async ({
      browser,
    }) => {
      await withShareableProject(async (projectPath) => {
        await withTwoBrowserPages(
          browser,
          { viewport },
          { viewport },
          async (host, guest) => {
            await openHostShare(host, projectPath);
            const created = await host.request.post("/api/shares", {
              data: { path: projectPath, role: "viewer" },
            });
            expect(created.ok(), await created.text()).toBeTruthy();
            const body = (await created.json()) as { share: { token: string } };
            await openGuestShare(guest, body.share.token);
            await expect(guest.locator(".guest-banner")).toBeVisible();

            // Stack the follow banner under the guest banner. Phone uses the
            // People menu while desktop keeps Follow controls in the avatar stack.
            await followUntilBannerVisible(guest, async () => {
              await openTransportMenu(guest);
            });
            await expect(guest.locator(".follow-banner")).toBeVisible();
            await expect(guest.locator(".guest-banner")).toBeVisible();

            await expectMenuLastItemReachable(guest);
          },
        );
      });
    });
  }
});
