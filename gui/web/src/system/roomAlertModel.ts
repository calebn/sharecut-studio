import type { StatusRowState } from "./StatusRow";

/**
 * Most urgent first. The slot shows one of these and counts the rest. Every kind
 * renders in the same polite status region and none switches to role="alert":
 * urgency shows in the wording, the glyph and the action, not in the live region.
 */
export const ROOM_ALERT_PRIORITY = [
  "mic-lost",
  "no-audio",
  "storage-failed",
  "saving-failed",
  "notice",
  "recovery",
  "host-offline",
  "monitor-failed",
  "clipping",
  "muted",
  "connecting",
  "generic",
] as const;

export type RoomAlertKind = (typeof ROOM_ALERT_PRIORITY)[number];

type RoomAlertText = {
  state: StatusRowState;
  /** `{name}` takes the host's name; generic takes its own message. */
  title: string;
  /** The one action's label. Absent when the alert has none. */
  action?: string;
  /** A second action beside it, offered when the caller passes `onSecondaryAction`. */
  secondary?: string;
};

export const MIC_CHECK_FAILED_COPY =
  "Still no audio: unmute or reconnect your microphone, then Check mic again.";

export const ROOM_ALERT_TEXT: Record<RoomAlertKind, RoomAlertText> = {
  "mic-lost": {
    state: "failed",
    title: "Your mic stopped.",
    action: "Reconnect mic",
  },
  "no-audio": {
    state: "needs-you",
    title: "No sound is reaching the recorder.",
    action: "Check mic",
  },
  "storage-failed": {
    state: "failed",
    title: "This device couldn't save the recording.",
    action: "Retry recording",
  },
  "saving-failed": {
    state: "failed",
    title: "Saving stopped.",
    action: "Resume saving",
    secondary: "Save a copy",
  },
  recovery: {
    state: "needs-you",
    title: "We found part of your recording.",
    action: "Finish saving",
  },
  "host-offline": {
    state: "needs-you",
    title: "{name} dropped. You're still recording on this device.",
  },
  "monitor-failed": {
    state: "failed",
    title: "You can't hear the room. Recording is fine.",
    action: "Retry",
  },
  clipping: {
    state: "needs-you",
    title: "You're clipping. Move back a little.",
  },
  muted: {
    state: "needs-you",
    title: "You're muted.",
  },
  notice: {
    state: "done",
    title: "Done.",
  },
  connecting: {
    state: "running",
    title: "Still connecting…",
    action: "Retry",
  },
  generic: {
    state: "needs-you",
    title: "Something went wrong in the room.",
    action: "Dismiss",
  },
};

export type RoomAlertInput = {
  kind: RoomAlertKind;
  /** The host's name for host-offline. Missing or blank reads "The host". */
  name?: string;
  /** The generic or notice alert's own sentence. Missing or blank keeps the default. */
  message?: string;
  /** No audio only: the last mic check found nothing, so the title says what to try. */
  checkFailed?: boolean;
  /** Without it the alert shows no action, even when its kind has one. */
  onAction?: () => void;
  /** Without it the alert shows no second action, even when its kind has one. */
  onSecondaryAction?: () => void;
};

function isRoomAlertKind(kind: string): kind is RoomAlertKind {
  return (ROOM_ALERT_PRIORITY as readonly string[]).includes(kind);
}

/** The one sentence an alert prints. */
export function roomAlertTitle({
  kind,
  name,
  message,
  checkFailed,
}: RoomAlertInput): string {
  if (kind === "generic" || kind === "notice")
    return message?.trim() || ROOM_ALERT_TEXT[kind].title;
  if (kind === "no-audio" && checkFailed)
    return `${ROOM_ALERT_TEXT[kind].title} ${MIC_CHECK_FAILED_COPY}`;
  const subject = name?.trim() || "The host";
  // A function replacer keeps "$&" and the like in a name literal.
  return ROOM_ALERT_TEXT[kind].title.replace("{name}", () => subject);
}

/** The one action an alert offers, or undefined when it has none to offer. */
export function roomAlertAction(
  alert: RoomAlertInput,
): { label: string; onAction: () => void } | undefined {
  const label = ROOM_ALERT_TEXT[alert.kind].action;
  if (!label || !alert.onAction) return undefined;
  return { label, onAction: alert.onAction };
}

/** The second action an alert offers, or undefined when it has none to offer. */
export function roomAlertSecondary(
  alert: RoomAlertInput,
): { label: string; onAction: () => void } | undefined {
  const label = ROOM_ALERT_TEXT[alert.kind].secondary;
  if (!label || !alert.onSecondaryAction) return undefined;
  return { label, onAction: alert.onSecondaryAction };
}

/**
 * Keeps the first alert of each known kind, orders them by priority and splits
 * off the most urgent. Unknown kinds are dropped, not shown as a guess.
 */
export function sortRoomAlerts<T extends { kind: string }>(
  active: readonly T[],
): { top: T | null; rest: T[] } {
  const seen = new Set<string>();
  const known: T[] = [];
  for (const alert of active) {
    if (!isRoomAlertKind(alert.kind) || seen.has(alert.kind)) continue;
    seen.add(alert.kind);
    known.push(alert);
  }
  known.sort(
    (a, b) =>
      ROOM_ALERT_PRIORITY.indexOf(a.kind as RoomAlertKind) -
      ROOM_ALERT_PRIORITY.indexOf(b.kind as RoomAlertKind),
  );
  const [top = null, ...rest] = known;
  return { top, rest };
}
