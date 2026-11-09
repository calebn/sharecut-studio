/** Viewport y where the sticky ruler and marker lane end; 0 when neither shows. */
export function timelineChromeBottom(): number {
  return Math.max(
    0,
    ...[".timeline-ruler", ".marker-lane"].flatMap((selector) => {
      const chrome = document.querySelector(selector);
      return chrome ? [chrome.getBoundingClientRect().bottom] : [];
    }),
  );
}
