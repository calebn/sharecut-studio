/**
 * What the page knows about a review link that may have been turned off. No
 * React: the request layer reports into it and one hook listens.
 */

export { isDeadLinkAnswer } from "../utils/apiError";
export { isLinkEnded, markLinkEnded } from "../utils/linkEnded";

type Listener = (token: string) => void;

const listeners = new Set<Listener>();

/** Someone saw a dead-link answer for `token`. With no listener it does nothing and keeps nothing. */
export function reportLinkDoubt(token: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(token);
    } catch {
      // A listener's failure must not reach the request that reported.
    }
  }
}

export function subscribeLinkDoubt(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A request refused because the link ended. An abort, so callers that ignore aborts stay silent. */
export function endedRequestError(): DOMException {
  return new DOMException("This link has ended.", "AbortError");
}
