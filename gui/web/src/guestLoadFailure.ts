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
        | "offline"
        | "busy"
        | "sign-in"
        | "restricted"
        | "unavailable"
        | "intercepted"
        | "server"
        | "no-review-routes";
    }
  | { kind: "rate-limited"; retryAfterSec: number | null };

export type GuestLoadCover = {
  glyph: "moon" | "triangle-alert" | "unlink" | "cloud-off";
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

/** The wait, in words a guest can plan around, for the delay the page will use. */
const waitInWords = (ms: number): string =>
  ms <= 30_000
    ? "in a moment"
    : ms <= 90_000
      ? "in about a minute"
      : "in about two minutes";

/**
 * `deviceOnline` is what the browser said when the attempt failed. A request
 * that got no answer while it says there is no connection is the guest's own
 * device; every other failure, with no answer or with one, is read as before:
 * something answered, or the page cannot tell, and says nothing it cannot know.
 */
export function classifyBootstrapFailure(
  error: unknown,
  deviceOnline = true,
): GuestLoadFailure {
  if (!(error instanceof ApiError)) {
    return error instanceof SyntaxError
      ? { kind: "intercepted" }
      : { kind: "unreachable" };
  }
  const { status, code } = error;
  if (status === null && !deviceOnline) {
    return { kind: "offline" };
  }
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
  if (status === 401) {
    return { kind: "sign-in" };
  }
  if (status === 403) {
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
    case "offline":
      return {
        glyph: "cloud-off",
        title: "You're offline",
        sentence:
          "This page opens the episode by itself when your connection is back.",
        button: "Try now",
        autoRetryMs: AUTO_RETRY_MS,
        stillFailing: "Still offline.",
      };
    case "busy":
      return {
        ...notLoaded,
        sentence:
          "This episode is busy for a moment; this page tries again every 30 seconds.",
        autoRetryMs: AUTO_RETRY_MS,
      };
    case "rate-limited": {
      const autoRetryMs = retryAfterMs(failure.retryAfterSec);
      return {
        ...notLoaded,
        sentence: `This link is busy right now; this page tries again ${waitInWords(autoRetryMs)}.`,
        autoRetryMs,
      };
    }
    case "sign-in":
      return {
        ...notLoaded,
        sentence:
          "This link needs a sign-in; ask the person who sent it how to sign in.",
        button: null,
      };
    case "restricted":
      return {
        ...notLoaded,
        sentence:
          "This link is only for certain people; ask the person who sent it to check it was made for you.",
        button: null,
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
