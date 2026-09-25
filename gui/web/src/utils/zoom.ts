import {
  effectiveMaxZoomPxPerSec,
  MIN_ZOOM_PX_PER_SEC,
  ZOOM_STEP,
} from "./timelineZoom.generated";

export {
  MAX_ZOOM_PX_PER_SEC,
  MIN_ZOOM_PX_PER_SEC,
  ZOOM_STEP,
} from "./timelineZoom.generated";

/** Session length (s) the zoom ceiling uses when no project is loaded. */
export const DEFAULT_SESSION_SEC = 60;

/** Session length the zoom ceiling uses (`timeline_duration_sec`, else 60 s). */
export function sessionSecOf(s: {
  project: { timeline_duration_sec?: number | null } | null | undefined;
}): number {
  return s.project?.timeline_duration_sec ?? DEFAULT_SESSION_SEC;
}

/**
 * Clamp zoom to `[MIN_ZOOM, effectiveMaxZoomPxPerSec(sessionSec)]`: near
 * sample level on a short session, and never wider than `MAX_CONTENT_PX`.
 */
export function clampZoomPxPerSec(zoom: number, sessionSec: number): number {
  return Math.min(
    effectiveMaxZoomPxPerSec(sessionSec),
    Math.max(MIN_ZOOM_PX_PER_SEC, zoom),
  );
}

export function discreteZoomFactor(direction: "in" | "out"): number {
  return direction === "in" ? ZOOM_STEP : 1 / ZOOM_STEP;
}

/** Sign-based factor for wheel / trackpad pinch (wheel+ctrl) ticks. */
export function wheelZoomFactor(deltaY: number): number {
  return deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
}

export const MIN_WAVEFORM_AMP = 1;
export const MAX_WAVEFORM_AMP = 16;

export function clampWaveformAmp(amp: number): number {
  if (!Number.isFinite(amp)) {
    return MIN_WAVEFORM_AMP;
  }
  return Math.min(MAX_WAVEFORM_AMP, Math.max(MIN_WAVEFORM_AMP, amp));
}

export type AnchoredZoomInput = {
  currentZoom: number;
  nextZoom: number;
  clientX: number;
  rectLeft: number;
  scrollLeft: number;
  /** Lowest logical scroll: 0, or −lead in a padded fixed-playhead view. */
  minScrollLeft?: number;
  /** Highest logical scroll, when the view knows it (the session end). */
  maxScrollLeft?: number;
  /** Session length (s): sets the zoom ceiling. */
  sessionSec: number;
};

export type AnchoredZoomResult = {
  zoom: number;
  scrollLeft: number;
};

/** Clamp zoom and keep the timeline time under clientX stable. */
export function anchoredZoomScroll(
  input: AnchoredZoomInput,
): AnchoredZoomResult {
  const zoom = clampZoomPxPerSec(input.nextZoom, input.sessionSec);
  const current = input.currentZoom > 0 ? input.currentZoom : zoom;
  const anchorX = input.clientX - input.rectLeft + input.scrollLeft;
  const anchorSec = anchorX / current;
  const scrollLeft = Math.min(
    input.maxScrollLeft ?? Number.POSITIVE_INFINITY,
    Math.max(
      input.minScrollLeft ?? 0,
      anchorSec * zoom - (input.clientX - input.rectLeft),
    ),
  );
  return { zoom, scrollLeft };
}

/** Zoom that fits `durationSec` into the full `viewportWidth` (time column). */
export function fitZoomPxPerSec(
  viewportWidth: number,
  durationSec: number,
  paddingPx = 0,
): number {
  if (!(viewportWidth > 0) || !(durationSec > 0)) {
    return MIN_ZOOM_PX_PER_SEC;
  }
  const usable = Math.max(1, viewportWidth - paddingPx);
  return clampZoomPxPerSec(usable / durationSec, durationSec);
}
