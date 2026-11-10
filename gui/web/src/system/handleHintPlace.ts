/** A span of the scrolling text, from `y` down by `height`, in pixels. */
export type Band = { y: number; height: number };

export type HandleHintInput = {
  /** The start grip's first line and the end grip's last, in the body's scrolling space. */
  start: Band;
  end: Band;
  /** The part of the scrolling text on screen now. */
  view: { top: number; height: number };
  tipHeight: number;
  /** How far a grip's knob and touch region reach past its line. */
  reach: number;
  /** The gap between a grip's reach and the tip. */
  gap: number;
};

/**
 * Where the one-time "Drag the handles" tip goes, as its top edge in the
 * body's scrolling space, or null when it cannot be fully seen anywhere.
 * Tried in order: under the end grip, above the start grip, then pinned to the
 * foot or the head of what is on screen, whichever covers less of the two
 * grips. A tip that would hang below the viewport (a short Script body in a
 * landscape tablet) is never returned: it would be clipped and the user would
 * dismiss it unseen.
 */
export function placeHandleHint(input: HandleHintInput): number | null {
  const { start, end, view, tipHeight, reach, gap } = input;
  const lo = view.top;
  const hi = view.top + view.height;
  const fits = (top: number) => top >= lo && top + tipHeight <= hi;
  const below = end.y + end.height + reach + gap;
  if (fits(below)) return below;
  const above = start.y - reach - gap - tipHeight;
  if (fits(above)) return above;
  if (tipHeight > view.height) return null;
  const grips: [number, number][] = [
    [start.y - reach, start.y + start.height],
    [end.y, end.y + end.height + reach],
  ];
  const covered = (top: number) =>
    grips.reduce(
      (sum, [a, b]) =>
        sum + Math.max(0, Math.min(b, top + tipHeight) - Math.max(a, top)),
      0,
    );
  const foot = hi - tipHeight;
  return covered(foot) <= covered(lo) ? foot : lo;
}
