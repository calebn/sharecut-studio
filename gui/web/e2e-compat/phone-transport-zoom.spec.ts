import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import {
  describeReach,
  reachFailures,
  TOUCH_FLOOR_PX,
} from "../e2e/reachability";

test.use({ hasTouch: true, isMobile: true, actionTimeout: 15_000 });

/** Half of iPhone 15 Plus CSS (430×932). Safari 200% page zoom substitute. */
const PAGE_ZOOM_LAYOUT = { width: 215, height: 466 };
const IPHONE_15_PLUS = { width: 430, height: 932 };

async function moreHub(page: Page) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "More" })
    .click();
  await expect(page.getByRole("button", { name: "History" })).toBeVisible();
}

async function transportDoesNotCoverHistory(page: Page) {
  const gap = await page.evaluate(() => {
    const bar = document
      .querySelector(".daw-shell-transport")
      ?.getBoundingClientRect();
    const history = [
      ...document.querySelectorAll<HTMLElement>(".mobile-more-item"),
    ]
      .find((el) => el.textContent?.trim() === "History")
      ?.getBoundingClientRect();
    if (!bar || !history) return null;
    return {
      barBottom: bar.bottom,
      historyTop: history.top,
    };
  });
  expect(gap).not.toBeNull();
  expect(gap!.historyTop + 0.5).toBeGreaterThanOrEqual(gap!.barBottom);
}

async function chromeReachable(page: Page, scope: string) {
  const failures = await reachFailures(page, { scope });
  expect(failures, describeReach(failures)).toEqual([]);
}

test("compact transport wraps at a 200% page-zoom layout width (#1636)", async ({
  page,
}) => {
  await page.setViewportSize(PAGE_ZOOM_LAYOUT);
  await openHostProject(page);
  await expect(page.locator(".daw-shell--phone")).toBeVisible();
  await moreHub(page);
  await chromeReachable(page, ".daw-shell-transport");
  await transportDoesNotCoverHistory(page);

  const wrapped = await page.evaluate(() => {
    const bar = document.querySelector(".transport--collapsed");
    if (!(bar instanceof HTMLElement)) return null;
    return {
      wrap: getComputedStyle(bar).flexWrap,
      minTarget: Math.min(
        ...[...bar.querySelectorAll<HTMLElement>("button")].map(
          (el) => el.offsetHeight,
        ),
      ),
    };
  });
  expect(wrapped?.wrap).toBe("wrap");
  expect(wrapped?.minTarget).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Listen" })
    .click();
  await expect(page.locator(".listen-hero")).toBeVisible();
  await chromeReachable(page, ".listen-hero");
  await expect(page.getByRole("button", { name: "+15s" })).toBeVisible();
  const time = page.locator(".listen-hero-time .timecode-current");
  await expect(time).toBeVisible();
  const timeBox = await time.boundingBox();
  expect(timeBox).not.toBeNull();
  expect(timeBox!.x + timeBox!.width).toBeLessThanOrEqual(
    PAGE_ZOOM_LAYOUT.width + 1,
  );
});

test("compact transport at 200% text keeps More History below the bar (#1636)", async ({
  page,
}) => {
  await page.setViewportSize(IPHONE_15_PLUS);
  await openHostProject(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(page.locator(".daw-shell--phone")).toBeVisible();
  await moreHub(page);
  await chromeReachable(page, ".daw-shell-transport");
  await transportDoesNotCoverHistory(page);
});
