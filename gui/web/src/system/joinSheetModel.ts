import type { PersonData } from "./Person";
import type { RoomPhase } from "./roomPhase";
import type { RoomRole } from "./roomViewModel";
import type { StatusRowState } from "./StatusRow";

/** Where the microphone is, from the first look to a working input. */
export type JoinMic =
  | { status: "idle" }
  | { status: "prompting" }
  | { status: "denied" }
  | {
      status: "lost";
      /** Why, in the caller's words: "Microphone disconnected." */
      detail?: string;
    }
  | {
      status: "ready";
      /** The input's name, as the browser reports it. */
      input: string;
      /** 0 to 1, the self level during the check. */
      level: number;
      /** A clip in the last 2 s. */
      clipped?: boolean;
      /** The inputs to pick from; the picker shows when there are two or more. */
      devices?: JoinInput[];
      /** The picked input's id; empty is the default input. */
      inputId?: string;
      /** A take is running, so the input cannot change now. */
      inputLocked?: boolean;
    };

export type JoinInput = { id: string; label: string };

export type JoinStep = "storage" | "name" | "mic" | "headphones";

export type JoinMicAction = "allow" | "how-to" | "retry";

/** What keeps the sheet from joining before any row: the device cannot keep a recording. */
export type JoinBlocker = {
  text: string;
  /** Absent while the check is still running. */
  action?: { label: string; name?: string };
};

export type JoinRow = {
  key: JoinStep;
  state: StatusRowState;
  title: string;
  detail?: string;
  action?: { label: string; name: string; kind: JoinMicAction | "blocker" };
};

export type JoinNote = { tone: "warning"; text: string };

type JoinGuestInput = {
  name: string;
  mic: JoinMic;
  headphones: boolean;
  /** The device is short on space. */
  lowStorage?: boolean;
  /** Lines the caller adds to the mic row, such as a missing saved input. */
  micNotes?: string[];
  /** Becomes the first unmet reason, before the name. */
  blocker?: JoinBlocker;
  joining?: boolean;
};

export type JoinPrimary = {
  label: string;
  /** What is missing, first row first. Absent when the button works or is busy. */
  reason: string | null;
  busy: boolean;
};

export type JoinGuestModel = {
  /** The blocker row first when there is one, then name, mic and headphones. */
  rows: JoinRow[];
  /** The mic row's lines under the meter: the caller's, too loud, low space. */
  micNotes: JoinNote[];
  /** The first row still to do, so a ready sheet has none. */
  next: JoinStep | null;
  ready: boolean;
  primary: JoinPrimary;
};

export type JoinProducerModel = {
  row: JoinRow;
  next: JoinStep | null;
  ready: boolean;
  primary: JoinPrimary;
};

export const JOIN_TEXT = {
  guestPrimary: "Join and record",
  producerPrimary: "Join to listen",
  joining: "Joining…",
  decline: "Not now",
  producerLine: "You'll listen and take notes. You won't be recorded.",
  headphones: "I'm wearing headphones",
  tooLoud: "Too loud. Move back a little.",
  defaultInput: "Default",
  inputLocked: "Can't change while a take is running.",
  lowStorage: "Low space on this device. Close other tabs.",
} as const;

const REASON: Record<JoinStep, string> = {
  storage: "Fix storage first",
  name: "Add your name first",
  mic: "Allow your microphone first",
  headphones: "Put on headphones first",
};

const MIC_REASON: Record<Exclude<JoinMic["status"], "ready">, string> = {
  idle: REASON.mic,
  prompting: "Answer your browser first",
  denied: "Unblock your microphone first",
  lost: "Reconnect your microphone first",
};

const STORAGE_PENDING_REASON = "Wait for the storage check first";

/** "Maya Okafor" reads "Maya" in a sentence. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${rest} others`;
}

/** The sheet's title: who is already in the room. */
export function joinHeadline(here: { person: PersonData }[]): string {
  const names = here
    .map((entry) => firstName(entry.person.name))
    .filter((name) => name !== "");
  if (names.length === 0) return "Join the room";
  return `${nameList(names)} ${names.length === 1 ? "is" : "are"} here`;
}

/** "Rosa is listening and won't be recorded", for the Details disclosure. */
export function listenersLine(
  here: { person: PersonData; role: RoomRole }[],
): string | null {
  const names = here
    .filter((entry) => entry.role === "producer")
    .map((entry) => firstName(entry.person.name))
    .filter((name) => name !== "");
  if (names.length === 0) return null;
  return `${nameList(names)} ${names.length === 1 ? "is" : "are"} listening and won't be recorded`;
}

/** The host's first name, or "the host" when the room has not named one. */
function hostName(host: string): string {
  return firstName(host) || "the host";
}

const possessive = (name: string) => `${name}'s`;

export function consentLine(host: string): string {
  return `You'll be recorded in full quality on this device. It saves to ${possessive(hostName(host))} project when the take ends.`;
}

export function consentDetails(host: string): string {
  const owner = hostName(host);
  return `Recording starts when ${owner} starts a take and stops when the take ends. Your audio is saved on this device first, then sent to ${possessive(owner)} project. Joining means you agree to be recorded.`;
}

function nameRow(name: string): JoinRow {
  return {
    key: "name",
    state: name.trim() === "" ? "queued" : "done",
    title: "Your name",
  };
}

export function micRow(mic: JoinMic): JoinRow {
  switch (mic.status) {
    case "idle":
      return {
        key: "mic",
        state: "queued",
        title: "Microphone",
        action: {
          label: "Allow microphone",
          name: "Allow microphone",
          kind: "allow",
        },
      };
    case "prompting":
      return {
        key: "mic",
        state: "running",
        title: "Microphone",
        detail: "Waiting for your browser…",
      };
    case "denied":
      return {
        key: "mic",
        state: "needs-you",
        title: "Microphone blocked",
        action: {
          label: "How to allow",
          name: "How to allow the microphone",
          kind: "how-to",
        },
      };
    case "lost":
      return {
        key: "mic",
        state: "failed",
        title: "Your microphone isn't available.",
        detail: mic.detail,
        action: { label: "Retry", name: "Retry microphone", kind: "retry" },
      };
    case "ready":
      return {
        key: "mic",
        state: "done",
        title: "Microphone",
        detail: mic.input,
      };
  }
}

function storageRow(blocker: JoinBlocker): JoinRow {
  const { action } = blocker;
  return {
    key: "storage",
    state: action ? "failed" : "running",
    title: "Storage",
    detail: blocker.text,
    action: action
      ? {
          label: action.label,
          name: action.name ?? action.label,
          kind: "blocker",
        }
      : undefined,
  };
}

export function headphonesRow(on: boolean): JoinRow {
  return {
    key: "headphones",
    state: on ? "done" : "queued",
    title: "Headphones",
  };
}

function primaryFor(
  label: string,
  reason: string | null,
  joining: boolean,
): JoinPrimary {
  if (joining) return { label: JOIN_TEXT.joining, reason: null, busy: true };
  return { label, reason, busy: false };
}

/** The mic row's lines under the meter: the caller's, then too loud. */
export function micNoteList(mic: JoinMic, extra: string[] = []): JoinNote[] {
  const notes: JoinNote[] = extra.map((text) => ({ tone: "warning", text }));
  if (mic.status === "ready" && mic.clipped) {
    notes.push({ tone: "warning", text: JOIN_TEXT.tooLoud });
  }
  return notes;
}

export function joinGuestModel(input: JoinGuestInput): JoinGuestModel {
  const rows = [
    ...(input.blocker ? [storageRow(input.blocker)] : []),
    nameRow(input.name),
    micRow(input.mic),
    headphonesRow(input.headphones),
  ];
  const next = rows.find((row) => row.state !== "done")?.key ?? null;
  const reason =
    next === null
      ? null
      : next === "storage"
        ? input.blocker?.action
          ? REASON.storage
          : STORAGE_PENDING_REASON
        : next === "mic" && input.mic.status !== "ready"
          ? MIC_REASON[input.mic.status]
          : REASON[next];
  const micNotes = micNoteList(input.mic, input.micNotes);
  if (input.lowStorage) {
    micNotes.push({ tone: "warning", text: JOIN_TEXT.lowStorage });
  }
  return {
    rows,
    micNotes,
    next,
    ready: next === null,
    primary: primaryFor(JOIN_TEXT.guestPrimary, reason, Boolean(input.joining)),
  };
}

export function joinProducerModel(input: {
  name: string;
  joining?: boolean;
}): JoinProducerModel {
  const row = nameRow(input.name);
  const next = row.state === "done" ? null : "name";
  return {
    row,
    next,
    ready: next === null,
    primary: primaryFor(
      JOIN_TEXT.producerPrimary,
      next === null ? null : REASON[next],
      Boolean(input.joining),
    ),
  };
}

/** The Declined state: tiles dim, a peek bar offers Join recording. */
export const DECLINED_TEXT = {
  line: "You're not being recorded.",
  join: "Join recording",
  wait: "You can join after this take.",
  reconnecting: "You can join once the room reconnects.",
} as const;

type DeclinedPeek = { disabledReason: string | null };

/**
 * Join recording works only while the room waits for a take: not through the
 * countdown, a live or paused take, saving, saved or a reconnect.
 */
export function declinedPeek(phase: RoomPhase): DeclinedPeek {
  switch (phase.kind) {
    case "waiting":
      return { disabledReason: null };
    case "reconnecting":
      return { disabledReason: DECLINED_TEXT.reconnecting };
    default:
      return { disabledReason: DECLINED_TEXT.wait };
  }
}
