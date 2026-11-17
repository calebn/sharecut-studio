import {
  classifyBootstrapFailure,
  type GuestLoadFailure,
  guestLoadCover,
  noAnswerStatus,
  STILL_NOT_LOADING,
} from "./guestLoadFailure";
import {
  ApiError,
  isDeadLinkAnswer,
  LINK_DOUBT_MESSAGE,
  PROJECT_NOT_FOUND_CODE,
  PROJECT_UNREADABLE_CODE,
} from "./utils/apiError";
import { NOT_SERVED_TITLE } from "./utils/notServed";

export type ShellGuestFailure = GuestLoadFailure | { kind: "doubt" };

export type HostLoadKind =
  | "missing"
  | "damaged"
  | "busy"
  | "elsewhere"
  | "not-answering"
  | "other";

/**
 * Why the studio's first read of the episode failed, after the studio had
 * opened, for the one reader (guest or host) who is looking at it. Chosen from
 * the status, the error code and the error class alone: nothing the server
 * said (`message`, `detail`, a body) is kept or read, so no sentence here can
 * carry it.
 */
export type ShellFailure =
  | { audience: "guest"; failure: ShellGuestFailure }
  | { audience: "host"; kind: HostLoadKind };

export type ShellCover = {
  /** What makes two failures "the same cover" for the status line after a press. */
  key: string;
  glyph: "moon" | "cloud-off" | "triangle-alert" | "folder-open" | "unlink";
  title: string;
  sentence: string;
  /** The button that tries again, or null when trying again cannot help. */
  retry: string | null;
  /** The host's All projects. */
  home: boolean;
  /** Which of the two buttons is the primary one. */
  lead: "retry" | "home";
  /** The status line when a press got the same failure; empty when there is no retry. */
  stillFailing: string;
  /** The status line when a press got a different cover; empty when there is no retry. */
  changed: string;
};

/** The server's own codes for an episode that cannot be opened, on a route a guest reads. */
const UNOPENABLE_CODES = new Set([
  PROJECT_UNREADABLE_CODE,
  "project_version_newer",
  "project_version_unsupported",
]);

const PROJECT_BUSY_CODE = "project_busy";
const PROJECT_PATH_NOT_ALLOWED_CODE = "project_path_not_allowed";

const isTimeout = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "TimeoutError";

function classifyGuest(
  error: unknown,
  deviceOnline: boolean,
): ShellGuestFailure {
  if (error instanceof ApiError) {
    const { status, code } = error;
    // The link passed its own check a moment ago: a coded 404 may still be a
    // stray, so the cover says so and keeps its button while the page confirms.
    if (isDeadLinkAnswer(status, code)) return { kind: "doubt" };
    // An uncoded 404 is a stray from something in between, not a dead link.
    if (status === 404 && code === null) return { kind: "server" };
    if (code !== null && UNOPENABLE_CODES.has(code)) {
      return { kind: "unavailable" };
    }
    return classifyBootstrapFailure(error, deviceOnline);
  }
  if (error instanceof SyntaxError || isTimeout(error)) {
    return classifyBootstrapFailure(error, deviceOnline);
  }
  // The host did answer, or the shape is not one anything knows: never "asleep".
  return { kind: "server" };
}

function classifyHost(error: unknown): HostLoadKind {
  if (error instanceof ApiError) {
    switch (error.code) {
      case PROJECT_UNREADABLE_CODE:
        return "damaged";
      case PROJECT_NOT_FOUND_CODE:
        return "missing";
      case PROJECT_BUSY_CODE:
        return "busy";
      case PROJECT_PATH_NOT_ALLOWED_CODE:
        return "elsewhere";
    }
    return noAnswerStatus(error.status, error.code) ? "not-answering" : "other";
  }
  return isTimeout(error) ? "not-answering" : "other";
}

export function classifyShellFailure(
  error: unknown,
  audience: "guest" | "host",
  deviceOnline: boolean,
): ShellFailure {
  return audience === "guest"
    ? { audience, failure: classifyGuest(error, deviceOnline) }
    : { audience, kind: classifyHost(error) };
}

type HostWords = {
  title?: string;
  glyph?: ShellCover["glyph"];
  sentence: (episode: string) => string;
  retry: string | null;
  home: boolean;
  lead: "retry" | "home";
  stillFailing?: string;
  changed?: string;
};

const TRY_AGAIN = "Try again";

const HOST_WORDS: Record<HostLoadKind, HostWords> = {
  missing: {
    sentence: (episode) =>
      `ShareCut can't find ${episode}. Its folder may have been moved, renamed or deleted.`,
    retry: TRY_AGAIN,
    home: true,
    lead: "home",
    stillFailing: "Still can't find it.",
    changed: "Can't find the episode.",
  },
  damaged: {
    sentence: (episode) =>
      `ShareCut can't read ${episode} because its file is damaged. Restore the file from a backup, or open a copy of the episode.`,
    retry: TRY_AGAIN,
    home: true,
    lead: "home",
    stillFailing: "Still can't read it.",
    changed: "The file is damaged.",
  },
  busy: {
    sentence: () => "Something else is using this episode for a moment.",
    retry: TRY_AGAIN,
    home: false,
    lead: "retry",
    stillFailing: "Still busy.",
    changed: "The episode is busy.",
  },
  elsewhere: {
    title: NOT_SERVED_TITLE,
    glyph: "folder-open",
    sentence: () => "This computer is open on a different episode.",
    retry: null,
    home: true,
    lead: "home",
  },
  "not-answering": {
    sentence: () =>
      "ShareCut isn't answering. Check that it is still running on this computer.",
    retry: TRY_AGAIN,
    home: false,
    lead: "retry",
    stillFailing: "Still not answering.",
    changed: "ShareCut isn't answering.",
  },
  other: {
    sentence: (episode) =>
      `ShareCut couldn't open ${episode}. If a newer version of ShareCut saved it, update ShareCut first.`,
    retry: TRY_AGAIN,
    home: true,
    lead: "retry",
    stillFailing: STILL_NOT_LOADING,
    changed: "It didn't open.",
  },
};

/**
 * The fixed words for a failure. `stageTitle` is the region's own title
 * ("The transcript didn't load" on Review, "Could not load the project"
 * elsewhere); `name` is the episode's name from its path, or empty. A guest
 * reads the page cover's words for the same cause.
 */
export function shellFailureCover(
  failure: ShellFailure,
  { stageTitle, name }: { stageTitle: string; name: string },
): ShellCover {
  if (failure.audience === "guest") {
    const guest = failure.failure;
    const cover =
      guest.kind === "doubt"
        ? {
            ...guestLoadCover({ kind: "server" }, stageTitle, TRY_AGAIN),
            sentence: LINK_DOUBT_MESSAGE,
          }
        : guestLoadCover(guest, stageTitle, TRY_AGAIN);
    return {
      key: cover.title,
      glyph: cover.glyph,
      title: cover.title,
      sentence: cover.sentence,
      retry: cover.button,
      home: false,
      lead: "retry",
      stillFailing: cover.stillFailing,
      changed: `${cover.title}.`,
    };
  }
  const words = HOST_WORDS[failure.kind];
  return {
    key: failure.kind,
    glyph: words.glyph ?? "triangle-alert",
    title: words.title ?? stageTitle,
    sentence: words.sentence(name ? `"${name}"` : "this episode"),
    retry: words.retry,
    home: words.home,
    lead: words.lead,
    stillFailing: words.stillFailing ?? "",
    changed: words.changed ?? "",
  };
}

/** Milliseconds until the page tries again by itself for this failure; null never does. */
export function autoRetryMsOf(failure: ShellFailure): number | null {
  if (failure.audience === "host" || failure.failure.kind === "doubt") {
    return null;
  }
  return guestLoadCover(failure.failure).autoRetryMs;
}

/** Whether the studio's cover is waiting for the connection to come back, with no attempt out. */
export function waitsForConnection(
  failure: ShellFailure | null,
  retrying: boolean,
): boolean {
  return (
    !retrying &&
    failure?.audience === "guest" &&
    failure.failure.kind === "offline"
  );
}
