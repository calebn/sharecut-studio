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
