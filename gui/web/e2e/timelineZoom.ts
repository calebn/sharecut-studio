import { expect, type Page } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";

export type ZoomTimelineInOptions = {
  /** Most `=` (`view.zoomIn`) presses. */
  maxSteps: number;
  /**
   * Stop once the scroller's horizontal range (scrollWidth − clientWidth)
   * exceeds this, and fail if it never does within `maxSteps`.
   */
  minRangePx?: number;
  /** Stop once a press leaves the ruler width unchanged (the zoom ceiling). */
  untilCeiling?: boolean;
};

export type ZoomTimelineInResult = {
  /** `=` presses made. */
  steps: number;
  /** Ruler content width after the last press (CSS px). */
  rulerWidthPx: number;
  /** With `untilCeiling`, a press left the ruler width unchanged. */
  atCeiling: boolean;
};

/** The timeline scroller's horizontal scroll range (CSS px). */
function timelineRangePx(page: Page): Promise<number> {
  return page
    .locator(".timeline-scroll")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
}

/**
 * Focus the timeline and zoom in with `=`, at most `opts.maxSteps` presses.
 * `view.zoomIn` runs only while the timeline focus region is active
 * (`timelineFocused`), so the first press must widen the ruler: a focus
 * regression fails there, at its cause, not in a later range or tile check.
 */
export async function zoomTimelineIn(
  page: Page,
  opts: ZoomTimelineInOptions,
): Promise<ZoomTimelineInResult> {
  await page.locator(".timeline-scroll").click();
  let width = await rulerWidthPx(page);
  let steps = 0;
  let atCeiling = false;
  while (steps < opts.maxSteps && !atCeiling) {
    await page.keyboard.press("=");
    steps += 1;
    if (steps === 1) {
      await expect
        .poll(() => rulerWidthPx(page), {
          message:
            "the first `=` did not zoom the timeline: is the timeline focus region active after clicking .timeline-scroll? (view.zoomIn needs timelineFocused)",
        })
        .toBeGreaterThan(width);
    }
    const next = await rulerWidthPx(page);
    atCeiling = opts.untilCeiling === true && next === width;
    width = next;
    if (
      opts.minRangePx !== undefined &&
      (await timelineRangePx(page)) > opts.minRangePx
    ) {
      break;
    }
  }
  if (opts.minRangePx !== undefined) {
    const min = opts.minRangePx;
    await expect
      .poll(() => timelineRangePx(page), {
        message: `timeline scroll range stayed at or below ${min}px after ${steps} of ${opts.maxSteps} zoom-in presses: fixture too short or ZOOM_STEP too small?`,
      })
      .toBeGreaterThan(min);
  }
  return { steps, rulerWidthPx: width, atCeiling };
}
