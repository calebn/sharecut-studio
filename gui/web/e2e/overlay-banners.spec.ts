import { expect, test } from "@playwright/test";
import { followUntilBannerVisible, withTwoHostPages } from "./followBanner";
import {
  expectMenuLastItemReachable,
  expectShareRecordRoomsReachable,
  openTransportMenu,
  SHORT_VIEWPORTS,
} from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

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
            const token = await createReviewShare(host, projectPath);
            await openGuestShare(guest, token);
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
