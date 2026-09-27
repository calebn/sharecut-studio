/**
 * Per-browser lane-height preference (#529): a fixed height in px, or "fit"
 * to fill the available stage height (see `timeline/timelineMetrics.ts`
 * `fitLaneHeight`). Persisted like `sharecut.tabsHeight` — a convenience for
 * this browser, not durable project state (see `docs/persistence.md`).
 */
import {
  DEFAULT_LANE_HEIGHT_PX,
  LANE_HEIGHT,
  LANE_HEIGHT_STEPS,
  MAX_FIT_LANE_HEIGHT,
} from "./layout";
import { readLocal, writeLocal } from "./storage";

export type LaneHeightMode = "fixed" | "fit";

export interface LaneHeightPref {
  mode: LaneHeightMode;
  px: number;
}

export const LANE_HEIGHT_STORAGE_KEY = "sharecut.laneHeight";

export const DEFAULT_LANE_HEIGHT_PREF: Readonly<LaneHeightPref> = Object.freeze(
  {
    mode: "fixed",
    px: DEFAULT_LANE_HEIGHT_PX,
  },
);

/** Clamp to the fit/fixed range; a non-finite input falls back to the default height. */
export function clampLaneHeightPx(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_LANE_HEIGHT_PX;
  const rounded = Math.round(px);
  return Math.min(MAX_FIT_LANE_HEIGHT, Math.max(LANE_HEIGHT, rounded));
}

/**
 * Next step strictly above/below the clamped current height. A value off the
 * step list (e.g. a clamped stored 150) steps to the next list entry above or
 * below it. At either end the current value is held.
 */
export function stepLaneHeightPx(
  current: number,
  direction: "up" | "down",
): number {
  const clamped = clampLaneHeightPx(current);
  if (direction === "up") {
    const next = LANE_HEIGHT_STEPS.find((step) => step > clamped);
    return next ?? LANE_HEIGHT_STEPS[LANE_HEIGHT_STEPS.length - 1];
  }
  const prev = [...LANE_HEIGHT_STEPS].reverse().find((step) => step < clamped);
  return prev ?? LANE_HEIGHT_STEPS[0];
}

function isLaneHeightMode(value: unknown): value is LaneHeightMode {
  return value === "fixed" || value === "fit";
}

/** Parses a stored preference; any missing/invalid shape falls back to the default. Never throws. */
export function parseLaneHeightPref(raw: string | null): LaneHeightPref {
  if (raw == null) return { ...DEFAULT_LANE_HEIGHT_PREF };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return { ...DEFAULT_LANE_HEIGHT_PREF };
    const { mode, px } = parsed as { mode?: unknown; px?: unknown };
    if (!isLaneHeightMode(mode)) return { ...DEFAULT_LANE_HEIGHT_PREF };
    return { mode, px: clampLaneHeightPx(typeof px === "number" ? px : NaN) };
  } catch {
    return { ...DEFAULT_LANE_HEIGHT_PREF };
  }
}

export function readLaneHeightPref(): LaneHeightPref {
  return parseLaneHeightPref(readLocal(LANE_HEIGHT_STORAGE_KEY));
}

export function writeLaneHeightPref(pref: LaneHeightPref): void {
  writeLocal(
    LANE_HEIGHT_STORAGE_KEY,
    JSON.stringify({ mode: pref.mode, px: clampLaneHeightPx(pref.px) }),
  );
}
