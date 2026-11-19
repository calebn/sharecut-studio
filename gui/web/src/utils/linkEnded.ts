/**
 * Review links whose session this page has ended. It lives for the page's
 * life (a reload starts clean) and sits outside `api/` so the saved-copy store
 * can read it without importing the request layer.
 */
const ended = new Set<string>();

/** The page's session for `token` has ended; no new request or saved-copy write for it may start. */
export function markLinkEnded(token: string): void {
  ended.add(token);
}

export function isLinkEnded(token: string): boolean {
  return ended.has(token);
}
