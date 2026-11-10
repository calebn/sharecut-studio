export type Box = { left: number; top: number; right: number; bottom: number };

export type TrimHintInput = {
  clip: Box;
  /** The part of the screen a tip may occupy: the lanes' visible window, margins taken off. */
  view: Box;
  tip: { width: number; height: number };
  /** Width of the start trim handle's strip, at the clip's left edge. */
  handle: number;
  gap: number;
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));

/**
 * Where the one-time trim tip goes, as its top-left corner in screen px, or
 * null when no spot shows all of it. Tried in order: above the clip, below it,
 * then over the clip itself past the start handle. It starts at the clip's
 * start, pulled back inside the view, and never lies over the handle.
 */
export function placeTrimHint(
  input: TrimHintInput,
): { left: number; top: number } | null {
  const { clip, view, tip, handle, gap } = input;
  if (tip.width > view.right - view.left) return null;
  const beside = clamp(clip.left, view.left, view.right - tip.width);
  const above = clip.top - gap - tip.height;
  if (above >= view.top && above + tip.height <= view.bottom)
    return { left: beside, top: above };
  const below = clip.bottom + gap;
  if (below >= view.top && below + tip.height <= view.bottom)
    return { left: beside, top: below };
  const inner = clamp(
    clip.left + handle + gap,
    view.left,
    view.right - tip.width,
  );
  const within = clip.top + gap;
  if (
    inner >= clip.left + handle &&
    inner < clip.right &&
    within >= view.top &&
    within + tip.height <= view.bottom
  )
    return { left: inner, top: within };
  return null;
}

/** The screen area the lanes show: not under the track headers, the sticky ruler or the viewport edge. */
export function visibleLanes(clip: HTMLElement, margin: number): Box {
  const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const scroller = clip.closest<HTMLElement>(".timeline-scroll");
  if (scroller) {
    const s = scroller.getBoundingClientRect();
    view.left = Math.max(view.left, s.left);
    view.top = Math.max(view.top, s.top);
    view.right = Math.min(view.right, s.left + scroller.clientWidth);
    view.bottom = Math.min(view.bottom, s.top + scroller.clientHeight);
    const headers = scroller.querySelector(".track-headers");
    if (headers)
      view.left = Math.max(view.left, headers.getBoundingClientRect().right);
    for (const row of scroller.querySelectorAll(
      ".timeline-ruler, .marker-lane",
    ))
      view.top = Math.max(view.top, row.getBoundingClientRect().bottom);
  }
  return {
    left: view.left + margin,
    top: view.top + margin,
    right: view.right - margin,
    bottom: view.bottom - margin,
  };
}
