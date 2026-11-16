import { useEffect, useRef } from "react";
import {
  isDeadLinkAnswer,
  loadReviewBootstrap,
  subscribeLinkDoubt,
} from "../api";
import { withAbortTimeout } from "../utils/abortTimeout";
import { ApiError } from "../utils/apiError";

/** How long the confirming check may take before it counts as "could not tell". */
export const CONFIRM_TIMEOUT_MS = 10_000;

/** After a check that found the link alive, further doubts within this wait cost nothing. */
export const QUIET_AFTER_ALIVE_MS = 5_000;

/**
 * Asks the link once more. True only when the answer is the dead-link answer
 * itself; a live link, a busy or unreachable host, a timeout, an abort and
 * every other failure all mean "not proven", and it never rejects.
 */
export async function confirmDeadLink(
  token: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await withAbortTimeout(
      CONFIRM_TIMEOUT_MS,
      "The server didn't answer.",
      (requestSignal) => loadReviewBootstrap(token, requestSignal),
      signal,
    );
    return false;
  } catch (error) {
    return (
      error instanceof ApiError && isDeadLinkAnswer(error.status, error.code)
    );
  }
}

/**
 * While `token` is set (a guest's episode is open), a doubt about that link
 * runs one confirming check, and only a confirmed dead link calls `onEnded`.
 * One check at a time, and none within a few seconds of one that found the
 * link alive. A result that arrives after the token changed or the page went
 * is dropped.
 */
export function useDeadLinkWatch(
  token: string | null,
  onEnded: (token: string) => void,
): void {
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });
  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    let inFlight = false;
    let quietUntil = 0;
    const controller = new AbortController();
    const unsubscribe = subscribeLinkDoubt((doubted) => {
      if (doubted !== token || inFlight || Date.now() < quietUntil) return;
      inFlight = true;
      void confirmDeadLink(token, controller.signal).then((dead) => {
        inFlight = false;
        if (cancelled) return;
        if (dead) ended.current(token);
        else quietUntil = Date.now() + QUIET_AFTER_ALIVE_MS;
      });
    });
    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
    };
  }, [token]);
}
