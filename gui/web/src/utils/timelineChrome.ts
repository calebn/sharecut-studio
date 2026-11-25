/** Viewport y where the sticky ruler and marker lane of `scope` end; 0 when neither shows. */
export function timelineChromeBottom(scope: ParentNode = document): number {
  return Math.max(
    0,
    ...[".timeline-ruler", ".marker-lane"].flatMap((selector) => {
      const chrome = scope.querySelector(selector);
      return chrome ? [chrome.getBoundingClientRect().bottom] : [];
    }),
  );
}

/**
 * Where a timeline scroller's pinned chrome ends: under the marker rows, or
 * under the ruler alone while a lane-editing sheet lets the rows scroll.
 */
export function pinnedChromeBottom(scroller: HTMLElement): number {
  const markers = scroller.querySelector(".marker-lane");
  if (markers && getComputedStyle(markers).position === "sticky")
    return markers.getBoundingClientRect().bottom;
  return (
    scroller.querySelector(".timeline-ruler")?.getBoundingClientRect().bottom ??
    scroller.getBoundingClientRect().top
  );
}
