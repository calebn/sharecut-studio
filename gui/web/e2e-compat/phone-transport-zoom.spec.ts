import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import {
  describeReach,
  reachFailures,
  TOUCH_FLOOR_PX,
} from "../e2e/reachability";

test.use({ hasTouch: true, isMobile: true, actionTimeout: 15_000 });

const IPHONE_15_PRO = { width: 393, height: 852 };
const SAFARI_AA_200_LAYOUT_VIEWPORT = { width: 197, height: 329 };

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

test("phone zoom keeps the compact transport and Listen timer inside the viewport (#1636)", async ({
  page,
}) => {
  await page.setViewportSize(SAFARI_AA_200_LAYOUT_VIEWPORT);
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
    SAFARI_AA_200_LAYOUT_VIEWPORT.width + 1,
  );
  const timerOverflow = await page
    .locator(".listen-hero-time")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(timerOverflow, "the current and total times fit the Listen card").toBe(
    0,
  );
});

test("compact transport at 200% text keeps More History below the bar (#1636)", async ({
  page,
}) => {
  await page.setViewportSize(IPHONE_15_PRO);
  await openHostProject(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(page.locator(".daw-shell--phone")).toBeVisible();
  await moreHub(page);
  await chromeReachable(page, ".daw-shell-transport");
  await transportDoesNotCoverHistory(page);
});
