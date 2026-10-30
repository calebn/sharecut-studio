import fs from "node:fs";
import type { Page } from "@playwright/test";
import { rulerStep, rulerTicks } from "../src/system/rulerMath";
import { timelineTestIds } from "../src/timeline/selectors";

/** Session length (s) of the stretched deep-zoom project. */
export const HOUR_SEC = 3600;
/** Layout tolerance (CSS px) for offsets at the 15 M px content ceiling. */
export const DEEP_ZOOM_TOLERANCE_PX = 1;

export type StretchedProject = {
  /** Track whose lane holds the moved clip and the added envelope. */
  trackId: string;
  clipStartSec: number;
  /** Volume-envelope point the spec expects on screen at the session end. */
  endPointSec: number;
};

type ProjectJson = {
  timeline: {
    duration_sec: number;
    clips: {
      id: string;
      track_id: string;
      source_start: number;
      source_end: number;
      timeline_start: number;
    }[];
  };
  mix?: {
    automation_envelopes?: {
      track_id: string;
      parameter: string;
      points: { id: string; time: number; value: number }[];
    }[];
  };
};

/**
 * Rewrite a disposable project copy so it spans `sessionSec`. Move the only
 * clip on `trackId` so it ends at `sessionSec`, set `timeline.duration_sec`,
 * and add a two-point volume envelope on that track (the second point 0.1 s
 * before the end). Throws when the track has no clip or several, or already
 * has a volume envelope, so lane-scoped checks measure exactly this clip.
 */
export function stretchProjectToSession(
  projectPath: string,
  sessionSec: number,
  trackId = "guest",
): StretchedProject {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8")) as ProjectJson;
  const clips = data.timeline.clips.filter((c) => c.track_id === trackId);
  const [clip] = clips;
  if (clips.length !== 1 || !clip) {
    throw new Error(
      `Expected one clip on track "${trackId}" in ${projectPath}, found ${clips.length}`,
    );
  }
  data.mix ??= {};
  data.mix.automation_envelopes ??= [];
  if (
    data.mix.automation_envelopes.some(
      (e) => e.track_id === trackId && e.parameter === "volume",
    )
  ) {
    throw new Error(
      `Track "${trackId}" already has a volume envelope in ${projectPath}`,
    );
  }
  clip.timeline_start = sessionSec - (clip.source_end - clip.source_start);
  data.timeline.duration_sec = sessionSec;
  const endPointSec = sessionSec - 0.1;
  data.mix.automation_envelopes.push({
    track_id: trackId,
    parameter: "volume",
    points: [
      { id: "deep-zoom-start", time: clip.timeline_start, value: 1 },
      { id: "deep-zoom-end", time: endPointSec, value: 0.5 },
    ],
  });
  fs.writeFileSync(projectPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { trackId, clipStartSec: clip.timeline_start, endPointSec };
}

/** Seconds for a ruler label (`m:ss[.f…]` or `h:mm:ss[.f…]`, see formatRulerTime). */
export function parseRulerLabel(label: string): number {
  const m = /^(?:(\d+):)?(\d+):(\d{2}(?:\.\d{1,4})?)$/.exec(label);
  if (!m) throw new Error(`Unparseable ruler label: ${label}`);
  const [, h, min, sec] = m;
  return (h ? Number(h) * 3600 : 0) + Number(min) * 60 + Number(sec);
}

/**
 * The last tick that shows a label when the ruler's window ends at the session
 * end, `widthPx` wide: the end label, or the one before when `rulerTicks` leaves
 * the end label off for room.
 */
export function expectedLastRulerTick(
  sessionSec: number,
  zoomPxPerSec: number,
  widthPx: number,
): { sec: number; step: number; label: string } {
  const start = sessionSec - widthPx / zoomPxPerSec;
  const step = rulerStep(zoomPxPerSec, sessionSec);
  const labelled = rulerTicks(
    start,
    zoomPxPerSec,
    widthPx,
    step,
    sessionSec,
  ).filter((tick) => tick.label !== "");
  const last = labelled.at(-1);
  if (!last) throw new Error("The ruler window has no labelled tick");
  return { sec: last.time, step, label: last.label };
}

/** Distance (px) from `offsetPx` to the nearest multiple of `gridPx`. */
export function offGridPx(offsetPx: number, gridPx: number): number {
  const r = ((offsetPx % gridPx) + gridPx) % gridPx;
  return Math.min(r, gridPx - r);
}

/** The ruler row's width (CSS px, fractional `getBoundingClientRect` width, the same measure as the lane geometry): the whole canvas, of which the ruler draws the visible window. */
export function rulerWidthPx(page: Page): Promise<number> {
  return page
    .locator(".timeline-ruler")
    .evaluate((el) => el.getBoundingClientRect().width);
}

/** The width (CSS px) of the ruler's drawn window, the time viewport. */
export function rulerWindowPx(page: Page): Promise<number> {
  return page
    .getByTestId(timelineTestIds.ruler)
    .evaluate((el) => el.getBoundingClientRect().width);
}
