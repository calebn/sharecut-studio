import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";
import { openProject } from "./stageNav";
import { type Point, touch } from "./touchTimeline";

/*
 * The phone shell shows the Create here menu as a bottom Sheet (#2294 S7b W1): a long press on
 * empty lane space opens it, a tap on a row runs the row, and a tap outside it closes it with no
 * seek.
 */

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const sheet = (page: Page) => page.getByRole("dialog", { name: /^Create at / });
const lane = '.lane-row[data-track-id="reference"]';

async function playheadSec(page: Page): Promise<number> {
  const now = await page
    .getByRole("slider", { name: "Timeline position" })
    .first()
    .getAttribute("aria-valuenow");
  return Number(now);
}

/** The trailing pad past the session's end under the fixed line: empty lane space. */
async function trailingPad(page: Page): Promise<Point> {
  const pad = await page.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
    const canvas = document.querySelector(".timeline-hit-root");
    const row = document.querySelector(selector);
    if (!scroller || !canvas || !row) return null;
    scroller.scrollLeft = scroller.scrollWidth;
    const end = canvas.getBoundingClientRect().right;
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return {
      x: Math.round((end + view.left + scroller.clientWidth) / 2),
      y: Math.round(box.top + box.height / 2),
    };
  }, lane);
  if (!pad) throw new Error("no timeline");
  return pad;
}

async function openSheet(page: Page): Promise<void> {
  await openProject(page, e2eProjectPath);
  await openPhoneTimeline(page);
  const at = await trailingPad(page);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, "touchStart", [at]);
  await expect(sheet(page)).toBeVisible();
  await touch(cdp, "touchEnd");
  await expect(sheet(page)).toBeVisible();
}

test("a long press on empty lane space opens the Sheet, and a tap on Add chapter here adds a chapter that one undo removes", async ({
  page,
}) => {
  await openSheet(page);
  const rows = sheet(page).locator(".sys-row-btn");
  await expect(rows).toHaveText([
    "Split here",
    "Comment here",
    "Add chapter here",
    "Record here",
    "Add volume point",
  ]);
  for (const row of await rows.all()) {
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator(".timeline-create-layer")).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Add chapter here" }).tap();
  await expect(sheet(page)).toHaveCount(0);
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(0);
});

test("a tap outside the Sheet closes it and does not move the playhead", async ({
  page,
}) => {
  await openSheet(page);
  const before = await playheadSec(page);
  const { y } = await trailingPad(page);
  await page.touchscreen.tap(60, y);
  await expect(sheet(page)).toHaveCount(0);
  expect(await playheadSec(page)).toBe(before);
});

test("the keymap is held while the Sheet is open, and Escape closes it", async ({
  page,
}) => {
  await openSheet(page);
  const before = await playheadSec(page);
  await page.keyboard.press("Home");
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Focus left with the Sheet and went to a live element, not the page.
  expect(
    await page.evaluate(
      () =>
        document.activeElement !== null &&
        document.activeElement !== document.body &&
        document.body.contains(document.activeElement),
    ),
  ).toBe(true);
  expect(await playheadSec(page)).toBe(before);
  await page.keyboard.press("Home");
  await expect.poll(() => playheadSec(page)).toBeLessThan(before);
});

test("a finger that slides from the held point onto a Sheet row and lifts picks that row once", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  await openPhoneTimeline(page);
  const at = await trailingPad(page);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, "touchStart", [at]);
  await expect(sheet(page)).toBeVisible();
  const box = await sheet(page)
    .getByRole("button", { name: "Add chapter here" })
    .boundingBox();
  if (!box) throw new Error("no row");
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const steps = 10;
  for (let k = 1; k <= steps; k += 1) {
    await touch(cdp, "touchMove", [
      {
        x: at.x + ((to.x - at.x) * k) / steps,
        y: at.y + ((to.y - at.y) * k) / steps,
      },
    ]);
  }
  await touch(cdp, "touchEnd");
  await expect(sheet(page)).toHaveCount(0);
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(1);
  // Leave the shared project as found: later specs measure its markers.
  await page.keyboard.press("Control+z");
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(0);
});
