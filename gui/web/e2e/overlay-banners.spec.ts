import { type Browser, expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  expectMenuLastItemReachable,
  expectShareRecordRoomsReachable,
  openTransportMenu,
  SHORT_VIEWPORTS,
} from "./overlayReachability";
import { withShareableProject } from "./shareableProject";

const PROXY_MANIFEST_TIMEOUT_MS = 15_000;

/**
 * Wait for lazy proxy setup before the disposable share workspace can be removed.
 */
async function openGuestShare(page: Page, token: string): Promise<void> {
  const manifestPath = `/api/review/${token}/daw/proxy/manifest`;
  const manifestResponse = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" && url.pathname === manifestPath
      );
    },
    { timeout: PROXY_MANIFEST_TIMEOUT_MS },
  );
  await page.goto(`/r/${token}`);
  await expect(page.locator(".daw-shell-guest")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  expect((await manifestResponse).status()).toBe(200);
}

/** Let host lazy audio/stem requests settle before a share workspace is reused. */
async function openHostShare(page: Page, projectPath: string): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible({
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
  await page.waitForLoadState("networkidle", {
    timeout: PROXY_MANIFEST_TIMEOUT_MS,
  });
}

async function twoHostPages(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{
  pageA: Page;
  pageB: Page;
  close: () => Promise<void>;
}> {
  const project = encodeURIComponent(e2eProjectPath);
  const aCtx = await browser.newContext({ viewport });
  const bCtx = await browser.newContext({ viewport });
  const pageA = await aCtx.newPage();
  const pageB = await bCtx.newPage();
  await pageA.goto(`/?project=${project}`);
  await pageB.goto(`/?project=${project}`);
  await expect(pageA.locator(".daw-shell")).toBeVisible();
  await expect(pageB.locator(".daw-shell")).toBeVisible();
  return {
    pageA,
    pageB,
    close: async () => {
      await aCtx.close();
      await bCtx.close();
    },
  };
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
      if (await follower.locator(".follow-banner").isVisible()) {
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
    if (await follower.locator(".follow-banner").isVisible()) {
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
      const { pageB, close } = await twoHostPages(browser, viewport);
      try {
        await followUntilBannerVisible(pageB, async () => {
          await openTransportMenu(pageB);
        });
        await expect(pageB.locator(".follow-banner")).toBeVisible();
        // The banner row above the transport shrinks --menu-available-height;
        // the menu must still fit and keep its last item reachable, and Share's
        // Record rooms must stay reachable through the dialog scroller.
        await expectMenuLastItemReachable(pageB);
        await expectShareRecordRoomsReachable(pageB);
      } finally {
        await close();
      }
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
        const aCtx = await browser.newContext({ viewport });
        const bCtx = await browser.newContext({ viewport });
        const host = await aCtx.newPage();
        const guest = await bCtx.newPage();
        try {
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
        } finally {
          await aCtx.close();
          await bCtx.close();
        }
      });
    });
  }
});
