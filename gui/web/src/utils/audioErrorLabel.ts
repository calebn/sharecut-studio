/**
 * Raised when Full mix has nothing rendered to play. The stale-mix pill already
 * names it and carries the fix, so the transport shows it on the Full mix
 * segment instead of as a second pill (#1113).
 */
export const NO_PREVIEW_ERROR = "No mix preview yet";

/** What a person can do about {@link NO_PREVIEW_ERROR}; a guest cannot refresh. */
export function noPreviewReason(mayRefresh: boolean): string {
  return mayRefresh
    ? `${NO_PREVIEW_ERROR}. Refresh the mix to hear it.`
    : `${NO_PREVIEW_ERROR}. The host needs to refresh the mix.`;
}

/**
 * Short, self-explaining pill label for a transport audio error. The full
 * message stays in the pill's tooltip and accessible name; the label has to
 * make sense on touch, where a tooltip never shows.
 */
export function audioErrorLabel(message: string): string {
  if (/^Failed to load audio/i.test(message)) {
    return "Audio failed to load";
  }
  if (/autoplay/i.test(message)) {
    return "Tap Play to start";
  }
  return "Audio error";
}
