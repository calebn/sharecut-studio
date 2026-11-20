import { devices, expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { playButton, seekTo } from "./playback";
import { scrollTimelineBy } from "./scroll";
import { openProject, phone, setAudition } from "./stageNav";
import { parseTimecodeSec } from "./timecode";
import { zoomTimelineIn } from "./timelineZoom";

/**
 * Playback is real, so each test seeks to a few seconds before the right edge
 * of the first view instead of playing from the start.
 */

const PILL = "Back to playhead in timeline";

type Probe = {
  inView: () => boolean;
  frames: number;
  outside: number;
};

type Box = { x: number; y: number; width: number; height: number };

async function watchPlayhead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe: Probe = {
      frames: 0,
      outside: 0,
      inView: () => {
        const scroller =
          document.querySelector<HTMLElement>(".timeline-scroll");
        const needle = document.querySelector<HTMLElement>(".playhead");
        if (!scroller || !needle) return false;
        const header =
          document
            .querySelector<HTMLElement>(".track-headers-chrome")
            ?.getBoundingClientRect().width ?? 0;
        const view = scroller.getBoundingClientRect();
        const x = needle.getBoundingClientRect().left;
        return x >= view.left + header - 1 && x <= view.right + 1;
      },
    };
    (window as unknown as { __probe: Probe }).__probe = probe;
    const tick = () => {
      probe.frames += 1;
      if (!probe.inView()) probe.outside += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const watched = (page: Page) =>
  page.evaluate(() => {
    const { frames, outside } = (window as unknown as { __probe: Probe })
      .__probe;
    return { frames, outside };
  });

const playheadInView = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __probe: Probe }).__probe.inView(),
  );

const scrollLeft = (page: Page) =>
  page.locator(".timeline-scroll").evaluate((el) => el.scrollLeft);

async function clockSec(page: Page): Promise<number> {
  return parseTimecodeSec(
    await page.locator(".stage-frame-player .sys-player-now").innerText(),
  );
}

async function openZoomedTimeline(page: Page): Promise<void> {
  await openProject(page, e2eProjectPath);
  await setAudition(page, "raw");
  await zoomTimelineIn(page, { maxSteps: 12, minRangePx: 1500 });
  await page.keyboard.press("Home");
  await page.locator(".timeline-scroll").evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect.poll(() => scrollLeft(page)).toBe(0);
  await watchPlayhead(page);
}

async function parkTheViewAwayFromThePlayhead(page: Page): Promise<void> {
  await seekTo(page, 2);
  await playButton(page).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await scrollTimelineBy(page, 600);
  await expect(page.getByRole("button", { name: PILL })).toBeVisible();
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

async function box(page: Page, selector: string): Promise<Box | null> {
  const target = page.locator(selector).first();
  return (await target.count()) ? target.boundingBox() : null;
}

test.afterEach(async ({ page }) => {
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.isVisible()) await pause.click();
});

test.describe("desktop timeline follow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the playhead stays inside the time viewport through a page flip", async ({
    page,
  }) => {
    await openZoomedTimeline(page);
    await seekTo(page, 12);
    await playButton(page).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0);
    await expect
      .poll(async () => (await watched(page)).frames)
      .toBeGreaterThan(90);
    const seen = await watched(page);
    expect(seen.outside, JSON.stringify(seen)).toBe(0);
    expect(await playheadInView(page)).toBe(true);
    await expect(page.getByRole("button", { name: PILL })).toHaveCount(0);
  });

  test("a manual scroll stops the follow and Back to playhead resumes it", async ({
    page,
  }) => {
    await openZoomedTimeline(page);
    await parkTheViewAwayFromThePlayhead(page);
    const parked = await scrollLeft(page);
    const clock = await clockSec(page);
    await expect.poll(() => clockSec(page)).toBeGreaterThan(clock + 1);
    expect(await scrollLeft(page)).toBe(parked);
    expect(await playheadInView(page)).toBe(false);

    const pill = page.getByRole("button", { name: PILL });
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect.poll(() => playheadInView(page)).toBe(true);
    expect(await scrollLeft(page)).not.toBe(parked);
  });

  test("Back to playhead hands focus to the timeline", async ({ page }) => {
    await openZoomedTimeline(page);
    await parkTheViewAwayFromThePlayhead(page);
    const pill = page.getByRole("button", { name: PILL });
    await pill.focus();
    await page.keyboard.press("Enter");
    await expect(pill).toHaveCount(0);
    await expect(page.locator(".timeline-scroll")).toBeFocused();
  });

  test("Play re-arms the follow and reveals an off-screen playhead", async ({
    page,
  }) => {
    await openZoomedTimeline(page);
    await parkTheViewAwayFromThePlayhead(page);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(playButton(page)).toBeVisible();
    expect(await playheadInView(page)).toBe(false);

    await playButton(page).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => playheadInView(page)).toBe(true);
    await expect(page.getByRole("button", { name: PILL })).toHaveCount(0);
  });
});

const LAYOUTS: readonly {
  name: string;
  viewport: { width: number; height: number };
  touch: boolean;
}[] = [
  {
    name: "desktop 1280x800",
    viewport: { width: 1280, height: 800 },
    touch: false,
  },
  {
    name: "tablet landscape 1024x768",
    viewport: { width: 1024, height: 768 },
    touch: true,
  },
  {
    name: "tablet portrait 820x1180",
    viewport: { width: 820, height: 1180 },
    touch: true,
  },
];

for (const layout of LAYOUTS) {
  test.describe(`Back to playhead pill, ${layout.name}`, () => {
    test.use({ viewport: layout.viewport, hasTouch: layout.touch });

    test("pill clears the edit corner, ruler and headers; one tap resumes the follow", async ({
      page,
    }) => {
      await openZoomedTimeline(page);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(layout.touch);
      await parkTheViewAwayFromThePlayhead(page);

      const pill = page.getByRole("button", { name: PILL });
      const pillBox = await pill.boundingBox();
      if (!pillBox) throw new Error("pill not measured");
      const area = await box(page, ".timeline-area");
      const ruler = await box(page, ".timeline-ruler");
      const headers = await box(page, ".track-headers-chrome");
      const corner = await box(page, ".edit-corner");
      for (const [name, other] of [
        ["edit corner", corner],
        ["ruler", ruler],
        ["track headers", headers],
      ] as const) {
        if (!other) throw new Error(`${name} is not on screen`);
        expect(
          overlaps(pillBox, other),
          `${name} ${JSON.stringify(other)}`,
        ).toBe(false);
      }
      if (!area) throw new Error("timeline area not measured");
      expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(
        area.x + area.width,
      );
      if (layout.touch) {
        expect(pillBox.height).toBeGreaterThanOrEqual(44);
      }

      const snap = page.getByRole("button", { name: /^Snap/ });
      const snapBefore = await snap.getAttribute("aria-pressed");
      const rangeBefore = await page
        .locator(".timeline-scroll")
        .evaluate((el) => el.scrollWidth);
      const parked = await scrollLeft(page);

      const at = {
        x: pillBox.x + pillBox.width / 2,
        y: pillBox.y + pillBox.height / 2,
      };
      if (layout.touch) {
        await page.touchscreen.tap(at.x, at.y);
      } else {
        await page.mouse.click(at.x, at.y);
      }

      await expect(pill).toHaveCount(0);
      await expect.poll(() => playheadInView(page)).toBe(true);
      expect(await scrollLeft(page)).not.toBe(parked);
      expect(
        await page.locator(".timeline-scroll").evaluate((el) => el.scrollWidth),
        "the zoom is unchanged",
      ).toBe(rangeBefore);
      expect(await snap.getAttribute("aria-pressed"), "Snap is unchanged").toBe(
        snapBefore,
      );
    });
  });
}

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];

test.describe("phone timeline keeps its fixed playhead", () => {
  test.use(iPhone);

  test("never shows the desktop pill on the fixed playhead during playback", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await setAudition(page, "raw");
    await phone.showTimeline(page);
    await playButton(page).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    const clock = await clockSec(page);
    await expect.poll(() => clockSec(page)).toBeGreaterThan(clock + 1);
    await expect(page.getByRole("button", { name: PILL })).toHaveCount(0);
    await expect(page.locator(".timeline-area--fixed-playhead")).toBeVisible();
  });
});
