import { expect, type Page, test } from "@playwright/test";
import { timelineTestIds } from "../src/timeline/selectors";
import { postDocumentCommand } from "./documentCommand";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { zoomTimelineIn } from "./timelineZoom";

const TRACK_COUNT = 20;
const VERTICAL_SCROLL_PX = 240;

type ChromeGeometry = {
  cornerTop: number;
  markerTop: number;
  rulerTop: number;
  firstTrackTop: number;
  scrollTop: number;
  verticalRange: number;
};

async function setupManyTrackProject(
  page: Page,
  projectPath: string,
): Promise<void> {
  for (let index = 2; index < TRACK_COUNT; index += 1) {
    const trackId = `ruler-track-${index}`;
    await postDocumentCommand(
      page,
      "pinned-ruler-e2e",
      "AddTrack",
      {
        track_id: trackId,
        label: `Ruler track ${index}`,
        role: "dialogue",
        speaker: trackId,
      },
      projectPath,
    );
  }
  await postDocumentCommand(
    page,
    "pinned-ruler-e2e",
    "AddChapter",
    { time: 15, title: "Ruler chapter" },
    projectPath,
  );
  await postDocumentCommand(
    page,
    "pinned-ruler-e2e",
    "AddComment",
    {
      body: "Ruler comment",
      author: "Playwright",
      timeline_start: 25,
      timeline_end: 28,
    },
    projectPath,
  );
}

async function readChromeGeometry(page: Page): Promise<ChromeGeometry> {
  return page.evaluate((ids) => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
    const corner = document.querySelector<HTMLElement>(".track-headers-chrome");
    const marker = document.querySelector<HTMLElement>(".marker-lane");
    const ruler = document.querySelector<HTMLElement>(
      `[data-testid="${ids.ruler}"]`,
    );
    const firstTrack = document.querySelector<HTMLElement>(".track-header-row");
    if (!scroller || !corner || !marker || !ruler || !firstTrack) {
      throw new Error("timeline chrome did not mount");
    }
    return {
      cornerTop: corner.getBoundingClientRect().top,
      markerTop: marker.getBoundingClientRect().top,
      rulerTop: ruler.getBoundingClientRect().top,
      firstTrackTop: firstTrack.getBoundingClientRect().top,
      scrollTop: scroller.scrollTop,
      verticalRange: scroller.scrollHeight - scroller.clientHeight,
    };
  }, timelineTestIds);
}

async function exercisePinnedRuler(page: Page): Promise<void> {
  await expect(page.locator(".stage-frame")).toBeVisible();
  await expect(page.locator(".timeline-scroll")).toBeVisible();
  await expect(page.locator(".track-header-row")).toHaveCount(TRACK_COUNT);
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(1);
  await expect(
    page.locator('.sys-marker[data-kind="comment"] .sys-marker-hit'),
  ).toHaveCount(1);

  const before = await readChromeGeometry(page);
  expect(before.verticalRange).toBeGreaterThan(VERTICAL_SCROLL_PX);
  await page.locator(".timeline-scroll").evaluate((element, amount) => {
    element.scrollTop = amount;
  }, VERTICAL_SCROLL_PX);
  await expect
    .poll(async () => (await readChromeGeometry(page)).scrollTop)
    .toBe(VERTICAL_SCROLL_PX);

  const after = await readChromeGeometry(page);
  expect(after.firstTrackTop).toBeLessThan(before.firstTrackTop - 100);
  expect(after.cornerTop).toBeCloseTo(before.cornerTop, 0);
  expect(after.rulerTop).toBeCloseTo(before.rulerTop, 0);
  expect(after.markerTop).toBeCloseTo(before.markerTop, 0);

  await page
    .locator('.sys-marker[data-kind="chapter"] .sys-marker-hit')
    .click();
  const playhead = page.getByRole("slider", { name: "Timeline position" });
  await expect(playhead).toHaveAttribute("aria-valuenow", "15");
  const inspector = page.getByRole("dialog", { name: "Inspector" });
  if (await inspector.count()) {
    await inspector.getByRole("button", { name: "Close" }).click();
  }

  await zoomTimelineIn(page, { maxSteps: 8, minRangePx: 100 });
  const scroller = page.locator(".timeline-scroll");
  await scroller.evaluate((element) => {
    // Near the end, with the session end well inside the view: a phone's end
    // pad lets the end scroll under the track headers.
    element.scrollLeft = Math.max(
      1,
      element.scrollWidth - element.clientWidth - element.clientWidth * 0.4,
    );
  });
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft > 0))
    .toBe(true);

  const seekPoint = await page.evaluate((ids) => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
    const ruler = document.querySelector<HTMLElement>(
      `[data-testid="${ids.ruler}"]`,
    );
    if (!scroller || !ruler) throw new Error("timeline ruler did not mount");
    const body = ruler.querySelector(".sys-ruler-body");
    if (!body) throw new Error("timeline ruler has no slider");
    const rulerBox = ruler.getBoundingClientRect();
    const scrollBox = scroller.getBoundingClientRect();
    const x = Math.min(rulerBox.right - 12, scrollBox.right - 20);
    // The ruler draws a window of the timeline, so time 0 is not at its left
    // edge once the timeline scrolls: read the scale off two labelled ticks.
    const ticks = [...ruler.querySelectorAll<HTMLElement>(".sys-ruler-tick")]
      .filter((tick) => tick.textContent)
      .map((tick) => {
        const box = tick.getBoundingClientRect();
        const clock = tick.textContent!.split(":").map(Number);
        return {
          seconds: clock.reduce((total, part) => total * 60 + part, 0),
          x: tick.dataset.align === "end" ? box.right : box.left,
        };
      });
    const first = ticks[0];
    const last = ticks.at(-1);
    if (!first || !last || first.seconds === last.seconds)
      throw new Error("the ruler shows fewer than two labelled ticks");
    const scale = (last.x - first.x) / (last.seconds - first.seconds);
    return {
      x,
      y: rulerBox.top + rulerBox.height / 2,
      expectedSec: Math.min(
        Number(body.getAttribute("aria-valuemax")),
        Math.max(0, first.seconds + (x - first.x) / scale),
      ),
    };
  }, timelineTestIds);
  await page.mouse.click(seekPoint.x, seekPoint.y);
  await expect
    .poll(async () => Number(await playhead.getAttribute("aria-valuenow")))
    .toBeCloseTo(seekPoint.expectedSec, 0);
}

test.describe("pinned timeline ruler (#409)", () => {
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await page.screenshot({ path: testInfo.outputPath("failure.png") });
    }
  });

  test("keeps the ruler, marker lane, and header corner at the top on desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await withShareableProject(async (projectPath) => {
      await setupManyTrackProject(page, projectPath);
      await openProject(page, projectPath);
      await exercisePinnedRuler(page);
    });
  });

  test("keeps the ruler, marker lane, and header corner at the top on phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await setupManyTrackProject(page, projectPath);
      await openProject(page, projectPath);
      await openPhoneTimeline(page);
      await exercisePinnedRuler(page);
    });
  });
});
