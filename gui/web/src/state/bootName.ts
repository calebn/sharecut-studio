import { cleanShareName } from "./shareName";

/**
 * The episode's name as the server wrote it into the page's root before the
 * script ran: the text of the loading header's heading, or null when the page
 * carries none (a link the server does not name, the recording room, a host's
 * page). The text is returned as it stands, not trimmed, so React's first
 * commit draws the same characters the page showed and nothing changes under
 * the guest's eyes.
 */
export function readBootName(root: Element | null): string | null {
  const heading = root?.querySelector(
    ":scope > main.guest-loading > h1.sr-only",
  );
  const text = heading?.textContent ?? "";
  return cleanShareName(text) === null ? null : text;
}
