/**
 * Geometry and paging for the touch target chooser (#1051 candidate A): chips
 * fan out on a shallow arc above the finger, below it near the top of the
 * timeline, and swing away from a side edge. Its timing (open after a long
 * press, grab after resting that long on a chip) is in `gestureConstants`.
 */
import type { HitCandidate, HitPoint } from "./hitCandidates";

export const CHOOSER_RISE_PX = 64;
export const CHOOSER_GAP_PX = 8;
/** How far the outermost chips bend back toward the finger. */
export const CHOOSER_SAG_PX = 12;
export const CHOOSER_EDGE_PX = 16;
/** Room for the caption (two lines while a chip is about to grab), on the side of the arc away from the finger. */
export const CHOOSER_LABEL_PX = 48;
/** Half the caption's widest line (15rem at 16 px), kept inside the gutter. */
export const CHOOSER_CAPTION_HALF_PX = 120;
export const CHOOSER_MAX_CHIPS = 5;

export type ChooserItem = { kind: "hit"; index: number } | { kind: "more" };

/**
 * The chips on `page`: every candidate when they fit, otherwise four ranked
 * candidates and "More…", which pages on and wraps. Each page reads left to
 * right by the targets' real x.
 */
export function chooserItems(
  candidates: readonly HitCandidate[],
  page: number,
): ChooserItem[] {
  const fits = candidates.length <= CHOOSER_MAX_CHIPS;
  const per = fits ? candidates.length : CHOOSER_MAX_CHIPS - 1;
  const pages = Math.max(1, Math.ceil(candidates.length / per));
  const start = (page % pages) * per;
  const indices = candidates
    .map((_, index) => index)
    .slice(start, start + per)
    .sort(
      (a, b) =>
        candidates[a].x - candidates[b].x ||
        candidates[b].priority - candidates[a].priority,
    );
  const items: ChooserItem[] = indices.map((index) => ({ kind: "hit", index }));
  return fits ? items : [...items, { kind: "more" }];
}

export interface ChipLayout {
  placement: "above" | "below";
  centers: HitPoint[];
  /** Caption anchor: its bottom centre above the arc, or top centre below. */
  caption: HitPoint;
}

/** Viewport px box the chooser stays inside, clear of app chrome. */
export interface ChooserBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The part of `element` inside the viewport (the viewport if none). */
export function visibleBox(element: Element | null): ChooserBounds {
  const r = element?.getBoundingClientRect();
  return {
    left: Math.max(0, r?.left ?? 0),
    top: Math.max(0, r?.top ?? 0),
    right: Math.min(window.innerWidth, r?.right ?? Number.POSITIVE_INFINITY),
    bottom: Math.min(window.innerHeight, r?.bottom ?? Number.POSITIVE_INFINITY),
  };
}

/**
 * Centres for `count` chips of `chipPx` around `finger`, kept with their
 * caption inside `bounds`: the timeline's visible box, so the chooser never
 * covers the transport bar, tabs or a sheet. Chips sit above the finger, or
 * below it when the caption would cross the top; when neither side has room,
 * the roomier side wins.
 */
export function layoutChips(
  count: number,
  finger: HitPoint,
  bounds: ChooserBounds,
  chipPx: number,
): ChipLayout {
  const pitch = chipPx + CHOOSER_GAP_PX;
  const half = (count - 1) / 2;
  const minX = bounds.left + CHOOSER_EDGE_PX + chipPx / 2;
  const maxX = bounds.right - CHOOSER_EDGE_PX - chipPx / 2;
  const first = finger.x - half * pitch;
  const last = finger.x + half * pitch;
  const shift =
    first < minX
      ? minX - first
      : last > maxX
        ? Math.max(minX - first, maxX - last)
        : 0;
  // Each side needs the rise, half a chip and the caption past the finger.
  const need = CHOOSER_RISE_PX + chipPx / 2 + CHOOSER_LABEL_PX;
  const roomAbove = finger.y - bounds.top - CHOOSER_EDGE_PX;
  const roomBelow = bounds.bottom - CHOOSER_EDGE_PX - finger.y;
  const placement =
    roomAbove >= need || roomAbove >= roomBelow ? "above" : "below";
  const rise = placement === "above" ? -CHOOSER_RISE_PX : CHOOSER_RISE_PX;
  const xs = Array.from(
    { length: count },
    (_, i) => finger.x + (i - half) * pitch + shift,
  );
  const reach = Math.max(pitch, ...xs.map((x) => Math.abs(x - finger.x)));
  const centers = xs.map((x) => {
    const t = (x - finger.x) / reach;
    return {
      x,
      y: finger.y + rise - Math.sign(rise) * CHOOSER_SAG_PX * t * t,
    };
  });
  const middle = (xs[0] + xs[xs.length - 1]) / 2;
  const captionHalf = CHOOSER_CAPTION_HALF_PX + CHOOSER_EDGE_PX;
  return {
    placement,
    centers,
    caption: {
      x: Math.min(
        bounds.right - captionHalf,
        Math.max(bounds.left + captionHalf, middle),
      ),
      y:
        placement === "above"
          ? Math.min(...centers.map((c) => c.y)) - chipPx / 2 - CHOOSER_GAP_PX
          : Math.max(...centers.map((c) => c.y)) + chipPx / 2 + CHOOSER_GAP_PX,
    },
  };
}
