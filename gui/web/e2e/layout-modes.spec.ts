import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { followUntilBannerVisible, withTwoHostPages } from "./followBanner";
import { openTransportMenu } from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

const VIEWPORT = { width: 1512, height: 805 };

type Box = { top: number; height: number };
type ShellRects = Record<
  "banners" | "follow" | "transport" | "main" | "tabs" | "status" | "content",
  Box
>;

async function shellRects(page: Page): Promise<ShellRects> {
  return page.locator(".daw-shell").evaluate((shell) => {
    const box = (el: Element | null): { top: number; height: number } => {
      if (!el || getComputedStyle(el).display === "none") {
        return { top: 0, height: 0 };
      }
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    };
    const child = (sel: string) => shell.querySelector(`:scope > ${sel}`);
    return {
      banners: box(child(".daw-shell-banners")),
      follow: box(child(".follow-banner")),
      transport: box(child(".daw-shell-transport")),
      main: box(child("main")),
      tabs: box(child(".bottom-tabs")),
      status: box(child(".status-bar")),
      content: box(shell.querySelector(".bottom-tabs .tab-content")),
    };
  });
}

async function setLayout(page: Page, n: number): Promise<void> {
  // Click a non-input so no text field owns the chord.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press(`ControlOrMeta+${n}`);
}

async function expectLayoutMatrix(page: Page): Promise<void> {
  const cases = [
    { n: 2, name: "timeline" },
    { n: 3, name: "text" },
    { n: 4, name: "review" },
    { n: 1, name: "default" },
  ] as const;
  for (const { n, name } of cases) {
    await setLayout(page, n);
    const chip = page.getByRole("button", { name: /· Restore$/ });
    if (name === "default") {
      await expect(chip).toHaveCount(0);
    } else {
      await expect(chip).toBeVisible();
    }
    const r = await shellRects(page);
    const bannerBottom = r.follow.height
      ? r.follow.top + r.follow.height
      : r.banners.top + r.banners.height;
    expect(Math.abs(r.transport.top - bannerBottom), name).toBeLessThanOrEqual(
      1,
    );
    expect(r.transport.height, name).toBeGreaterThanOrEqual(40);
    expect(
      Math.abs(r.main.top - (r.transport.top + r.transport.height)),
      name,
    ).toBeLessThanOrEqual(1);
    expect(r.main.height, name).toBeGreaterThan(100);
    expect(r.status.height, name).toBeGreaterThanOrEqual(20);
    expect(
      Math.abs(r.status.top + r.status.height - VIEWPORT.height),
      name,
    ).toBeLessThanOrEqual(1);
    if (name === "timeline") {
      expect(r.tabs.height).toBe(0);
    } else if (name === "default") {
      expect(r.tabs.height).toBeGreaterThan(60);
    } else {
      expect(r.content.height, name).toBeGreaterThan(60);
    }
    if (name !== "default") {
      const box = await chip.boundingBox();
      expect(box, name).not.toBeNull();
      if (box) {
        expect(box.y).toBeGreaterThanOrEqual(r.transport.top - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(
          r.transport.top + r.transport.height + 1,
        );
      }
    }
  }
}

async function withGuestViewer(
  browser: Parameters<typeof withTwoHostPages>[0],
  run: (guest: Page) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    await withTwoBrowserPages(
      browser,
      { viewport: VIEWPORT },
      { viewport: VIEWPORT },
      async (host, guest) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath);
        await openGuestShare(guest, token);
        await run(guest);
      },
    );
  });
}

test.describe("layout modes keep the shell rows", () => {
  test.use({ viewport: VIEWPORT });

  test("host with attention, not following", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectLayoutMatrix(page);
  });

  test("bare digits no longer change the layout", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("2");
    await expect(page.locator(".daw-shell")).not.toHaveClass(
      /daw-shell--layout-timeline/,
    );
  });

  test("host following a peer", async ({ browser }) => {
    await withTwoHostPages(browser, VIEWPORT, async (_pageA, pageB) => {
      await followUntilBannerVisible(pageB, async () => {
        await openTransportMenu(pageB);
      });
      await expectLayoutMatrix(pageB);
    });
  });

  test("guest viewer, not following", async ({ browser }) => {
    await withGuestViewer(browser, async (guest) => {
      await expect(guest.locator(".guest-banner")).toBeVisible();
      await expectLayoutMatrix(guest);
    });
  });

  test("guest viewer, following the host", async ({ browser }) => {
    await withGuestViewer(browser, async (guest) => {
      await followUntilBannerVisible(guest, async () => {
        await openTransportMenu(guest);
      });
      await expect(guest.locator(".follow-banner")).toBeVisible();
      await expectLayoutMatrix(guest);
    });
  });
});
