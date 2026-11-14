import { ApiError } from "./utils/apiError";

/**
 * Why a review link did not load, reduced to what a guest can act on. Chosen
 * from the status, the error code and the error class alone: no response text
 * (`detail`, `message`, body) ever reaches the screen, because the page cannot
 * tell a sentence written for people from an internal one.
 */
export type GuestLoadFailure =
  | {
      kind:
        | "bad-link"
        | "unreachable"
        | "busy"
        | "restricted"
        | "unavailable"
        | "intercepted"
        | "server"
        | "no-review-routes";
    }
  | { kind: "rate-limited"; retryAfterSec: number | null };

export type GuestLoadCover = {
  glyph: "moon" | "triangle-alert" | "unlink";
  title: string;
  sentence: string;
  /** The cover's one button, or null when nothing a guest does here helps. */
  button: string | null;
  /** Milliseconds until the page tries again by itself; null never does. */
  autoRetryMs: number | null;
  /** What the status line says when a press did not get the episode open. */
  stillFailing: string;
};

const AUTO_RETRY_MS = 30_000;
const MIN_RETRY_AFTER_SEC = 5;
const MAX_RETRY_AFTER_SEC = 120;

const BAD_LINK_TITLE = "This link doesn't open anything";
const BAD_LINK_SENTENCE = "Ask the person who sent it for a new link.";

const NOT_LOADED_TITLE = "This link did not load";
const STILL_NOT_LOADING = "Still not loading.";

const retryAfterMs = (seconds: number | null): number =>
  seconds === null
    ? AUTO_RETRY_MS
    : Math.min(Math.max(seconds, MIN_RETRY_AFTER_SEC), MAX_RETRY_AFTER_SEC) *
      1000;

export function classifyBootstrapFailure(error: unknown): GuestLoadFailure {
  if (!(error instanceof ApiError)) {
    return error instanceof SyntaxError
      ? { kind: "intercepted" }
      : { kind: "unreachable" };
  }
  const { status, code } = error;
  if (
    status === null ||
    status === 502 ||
    status === 504 ||
    (status === 503 && code !== "project_busy")
  ) {
    return { kind: "unreachable" };
  }
  if (status === 503) {
    return { kind: "busy" };
  }
  if (status === 404) {
    return code === null || code === "share_not_found"
      ? { kind: "bad-link" }
      : { kind: "unavailable" };
  }
  if (status === 429) {
    return { kind: "rate-limited", retryAfterSec: error.retryAfterSec };
  }
  if (status === 401 || status === 403) {
    return { kind: "restricted" };
  }
  return { kind: "server" };
}

export function guestLoadCover(failure: GuestLoadFailure): GuestLoadCover {
  const notLoaded = {
    glyph: "triangle-alert",
    title: NOT_LOADED_TITLE,
    button: "Retry",
    autoRetryMs: null,
    stillFailing: STILL_NOT_LOADING,
  } as const;
  switch (failure.kind) {
    case "bad-link":
      return {
        glyph: "unlink",
        title: BAD_LINK_TITLE,
        sentence: BAD_LINK_SENTENCE,
        button: null,
        autoRetryMs: null,
        stillFailing: STILL_NOT_LOADING,
      };
    case "unreachable":
      return {
        glyph: "moon",
        title: "The host's computer is asleep",
        sentence: "This page tries again every 30 seconds.",
        button: "Try now",
        autoRetryMs: AUTO_RETRY_MS,
        stillFailing: "Still asleep.",
      };
    case "busy":
      return {
        ...notLoaded,
        sentence:
          "The host's computer is busy; this page tries again every 30 seconds.",
        autoRetryMs: AUTO_RETRY_MS,
      };
    case "rate-limited":
      return {
        ...notLoaded,
        sentence:
          "This link is busy right now; this page tries again in a moment.",
        autoRetryMs: retryAfterMs(failure.retryAfterSec),
      };
    case "restricted":
      return {
        ...notLoaded,
        sentence:
          "This link is only for certain people; ask the person who sent it to check it was made for you.",
      };
    case "unavailable":
      return {
        ...notLoaded,
        sentence:
          "This link isn't available right now; ask the person who sent it to check it.",
      };
    case "intercepted":
      return {
        ...notLoaded,
        sentence:
          "This network did not pass the page through; on public Wi-Fi, sign in to the Wi-Fi first, then try again.",
      };
    case "no-review-routes":
      return {
        ...notLoaded,
        sentence:
          "This address cannot open review links; ask the person who sent it to check the link.",
        button: null,
      };
    case "server":
      return {
        ...notLoaded,
        sentence:
          "Try again, and if it keeps happening, tell the person who sent it.",
      };
  }
}
