import fs from "node:fs";
import type { Page } from "@playwright/test";
import {
  estimateRulerLabelWidthPx,
  rulerEndTickDropped,
} from "../src/timeline/rulerTicks";
import { formatRulerTime, niceTimeStep } from "../src/utils/time";

/** Session length (s) of the stretched deep-zoom project. */
export const HOUR_SEC = 3600;
/** Layout tolerance (CSS px) for offsets at the 15 M px content ceiling. */
export const DEEP_ZOOM_TOLERANCE_PX = 1;

export type StretchedProject = {
  clipId: string;
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
 * Rewrite a disposable project copy so it spans `sessionSec`. Move the clip
 * on `trackId` so it ends at `sessionSec`, set `timeline.duration_sec`, and
 * add a two-point volume envelope on that track (the second point 0.1 s
 * before the end).
 */
export function stretchProjectToSession(
  projectPath: string,
  sessionSec: number,
  trackId = "guest",
): StretchedProject {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8")) as ProjectJson;
  const clip = data.timeline.clips.find((c) => c.track_id === trackId);
  if (!clip) throw new Error(`No clip on track "${trackId}" in ${projectPath}`);
  clip.timeline_start = sessionSec - (clip.source_end - clip.source_start);
  data.timeline.duration_sec = sessionSec;
  const endPointSec = sessionSec - 0.1;
  data.mix ??= {};
  data.mix.automation_envelopes ??= [];
  data.mix.automation_envelopes.push({
    track_id: trackId,
    parameter: "volume",
    points: [
      { id: "deep-zoom-start", time: clip.timeline_start, value: 1 },
      { id: "deep-zoom-end", time: endPointSec, value: 0.5 },
    ],
  });
  fs.writeFileSync(projectPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { clipId: clip.id, clipStartSec: clip.timeline_start, endPointSec };
}

/** Seconds for a ruler label (`m:ss[.f…]` or `h:mm:ss[.f…]`, see formatRulerTime). */
export function parseRulerLabel(label: string): number {
  const m = /^(?:(\d+):)?(\d+):(\d{2}(?:\.\d{1,4})?)$/.exec(label);
  if (!m) throw new Error(`Unparseable ruler label: ${label}`);
  const [, h, min, sec] = m;
  return (h ? Number(h) * 3600 : 0) + Number(min) * 60 + Number(sec);
}

/** The ruler's last rendered tick at the session end: the end label, or the one before when the end label is dropped (#169). */
export function expectedLastRulerTick(
  sessionSec: number,
  zoomPxPerSec: number,
): { sec: number; step: number; label: string } {
  const step = niceTimeStep(zoomPxPerSec);
  const last = Math.floor(sessionSec / step + 1e-9);
  const width = sessionSec * zoomPxPerSec;
  const dropped = rulerEndTickDropped(
    sessionSec,
    step,
    zoomPxPerSec,
    width,
    estimateRulerLabelWidthPx(last * step, step),
  );
  const i = dropped ? last - 1 : last;
  return { sec: i * step, step, label: formatRulerTime(i * step, step) };
}

/** Distance (px) from `offsetPx` to the nearest multiple of `gridPx`. */
export function offGridPx(offsetPx: number, gridPx: number): number {
  const r = ((offsetPx % gridPx) + gridPx) % gridPx;
  return Math.min(r, gridPx - r);
}

/** Ruler content width (CSS px, integer layout width). */
export function rulerWidthPx(page: Page): Promise<number> {
  return page
    .locator(".time-ruler")
    .evaluate((el) => (el as HTMLElement).offsetWidth);
}
