import { MIX_MISSING_LABEL } from "./staleRender";

/**
 * Raised when Full mix has nothing rendered to play. The status pill already
 * says "No mix yet" and carries the fix, so the transport does not repeat it as
 * a second pill (#1113).
 */
export const NO_PREVIEW_ERROR = MIX_MISSING_LABEL;

/**
 * What the missing mix means for Full mix and who can fix it; a guest cannot
 * refresh. Sits on the Full mix segment and in the phone Menu.
 */
export function noPreviewReason(mayRefresh: boolean): string {
  return mayRefresh
    ? "Full mix is silent until you refresh the mix."
    : "Full mix is silent until the host refreshes the mix.";
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
