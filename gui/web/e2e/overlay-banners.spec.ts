import { expect, test } from "@playwright/test";
import {
  followPill,
  followUntilPillVisible,
  openPeopleMenu,
  withTwoHostPages,
} from "./follow";
import {
  expectMenuLastItemReachable,
  SHORT_VIEWPORTS,
} from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

test.describe("overlay while following", () => {
  for (const viewport of SHORT_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    test(`menu last item stays reachable at ${label}`, async ({ browser }) => {
      await withTwoHostPages(browser, viewport, async (_pageA, pageB) => {
        await followUntilPillVisible(pageB);
        await expect(followPill(pageB)).toBeVisible();
        // The menu must still fit and keep its last item reachable.
        await expectMenuLastItemReachable(pageB);
      });
    });
  }
});

test.describe("overlay with guest banner and follow pill", () => {
  for (const viewport of [
    { width: 1280, height: 715 },
    { width: 390, height: 844 },
  ]) {
    test(`menu last item stays reachable with the guest banner and follow pill at ${viewport.width}x${viewport.height}`, async ({
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

            // Phone uses the People menu while desktop keeps Follow controls
            // in the avatar stack.
            await followUntilPillVisible(guest);
            await expect(followPill(guest)).toBeVisible();
            await expect(guest.locator(".guest-banner")).toBeVisible();

            // A shared link has no Project menu; the People menu is its menu.
            await expectMenuLastItemReachable(guest, openPeopleMenu);
          },
        );
      });
    });
  }
});
