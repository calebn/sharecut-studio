import {
  type NoteItem,
  noteSnippet,
  sortNotes,
  visibleNotes,
} from "./notesRailModel";
import type { PersonData } from "./Person";
import type { RecordFace } from "./RecordButton";
import type { DockSeat } from "./RecordDock";
import type { RoomAlertInput } from "./roomAlertModel";
import { type RoomPhase, savingPercent } from "./roomPhase";
import {
  effectiveLive,
  type RoomConnection,
  type RoomSaving,
  type RoomTileProps,
} from "./roomTileModel";

export type RoomRole = DockSeat;
export type ViewerWidth = "desktop" | "phone" | "phone-landscape";

/** One person in the room as the viewer's client knows them. */
export type RoomPerson = {
  /** The participant's id; keys the tile so two people with one name stay apart. */
  id?: string;
  role: RoomRole;
  person: PersonData;
  /** The viewer's own entry. */
  you?: boolean;
  presence: "live" | "joining" | "declined" | "left";
  level?: number;
  speaking?: boolean;
  muted?: boolean;
  connection?: RoomConnection;
  clipped?: number;
  alert?: boolean;
  saving?: RoomSaving | null;
};

export type RoomViewInput = {
  role: RoomRole;
  people: RoomPerson[];
  phase: RoomPhase;
  viewerWidth: ViewerWidth;
  /** The viewer's Notes choice. Undefined keeps the role's default. */
  notesOpen?: boolean;
  /** Alerts the caller already knows about. The slot sorts and de-duplicates them. */
  alerts?: RoomAlertInput[];
  /** Whether the host can invite. Without a handler the host gets no Invite slots. */
  invite?: boolean;
  canRecord?: boolean;
  notes?: NoteItem[];
  selfName?: string;
};

export type NotePeek = {
  author: string;
  text: string;
  time: string | null;
};

export type RoomRecord = { face: RecordFace; disabledReason?: string };

type RoomListener = { key: string; person: PersonData; label?: string };

/** A person's tile, or an Invite slot the host can fill. */
type RoomTileEntry =
  | { key: string; kind: "person"; props: RoomTileProps }
  | { key: string; kind: "invite" };

type RoomViewModel = {
  tiles: RoomTileEntry[];
  columns: 1 | 2 | 3 | 4;
  listeners: RoomListener[];
  dockSeat: DockSeat;
  showComment: boolean;
  railOpen: boolean;
  sheetOpen: boolean;
  notesOpen: boolean;
  peek: NotePeek | null;
  record: RoomRecord | null;
  dock: RoomDock;
  alerts: RoomAlertInput[];
};

/** What the dock's centre holds for this seat and phase, and why Leave is held if it is. */
export type RoomDock =
  /** Mute, Comment, Notes. `leaveHeld` is a guest's reason while their take is unsaved. */
  | { kind: "controls"; leaveHeld?: string }
  /** A status line in place of the centre controls. */
  | { kind: "status"; text: string; leaveHeld?: string }
  /** A guest's take is saved: the line, Done as the one primary, no Leave. */
  | { kind: "done"; text: string };

export const LEAVE_DURING_TAKE_REASON = "You can leave after this take.";
export const LEAVE_WHILE_SAVING_REASON = "Your recording is still saving";
export const SAVED_DOCK_LINE = "Saved to project. You can close this page.";

export const isPhoneWidth = (width: ViewerWidth) => width !== "desktop";

/** The host's room holds at most four recorded people, the host included. */
const RECORDED_CAP = 4;

/** Producers listen; everyone else is recorded. */
const isRecorded = (person: RoomPerson) => person.role !== "producer";

/**
 * For a host who can invite: a guest who declined frees their place, and so does one who
 * left before the take, but a guest who drops during or after a take keeps their tile.
 */
const isGone = (person: RoomPerson, phase: RoomPhase) =>
  !person.you &&
  (person.presence === "declined" ||
    (person.presence === "left" &&
      (phase.kind === "waiting" || phase.kind === "countdown")));

/** The id when the caller has one; otherwise role and name, which collide for two guests called "Guest". */
const personKey = (entry: RoomPerson) =>
  entry.id ?? `${entry.role}-${entry.person.name}`;

/** The viewer's own tile leads the grid. */
function ownFirst(people: RoomPerson[]): RoomPerson[] {
  return [
    ...people.filter((person) => person.you),
    ...people.filter((person) => !person.you),
  ];
}

/**
 * The person tile's props. A live person goes through effectiveLive, so the
 * ring and the speaking flag match what the tile itself would draw.
 */
export function tileProps(entry: RoomPerson): RoomTileProps {
  const host = entry.role === "host";
  if (entry.presence !== "live") {
    return { presence: entry.presence, person: entry.person, host };
  }
  const flags = {
    presence: "live" as const,
    person: entry.person,
    host,
    level: entry.level,
    speaking: entry.speaking,
    muted: entry.muted,
    connection: entry.connection,
    listener: entry.role === "producer",
    clipped: entry.clipped,
    alert: entry.alert,
    isMe: entry.you,
    saving: entry.saving,
  };
  const { level, speaking } = effectiveLive(flags);
  return { ...flags, level, speaking };
}

/**
 * Host-offline is the guest's alert: the host has left, or their connection
 * dropped while they are on air. Only a guest's view shows it; a producer's
 * room has no recording of its own to fall back on.
 */
function hostOffline(people: RoomPerson[]): RoomAlertInput[] {
  const host = people.find((person) => person.role === "host");
  if (!host) return [];
  const dropped =
    host.presence === "left" ||
    (host.presence === "live" && host.connection === "lost");
  return dropped ? [{ kind: "host-offline", name: host.person.name }] : [];
}

export function notePeek(
  notes: readonly NoteItem[],
  role: RoomRole,
  selfName: string,
): NotePeek | null {
  const latest = sortNotes(visibleNotes(notes, role, selfName)).at(-1);
  if (!latest) return null;
  return {
    author: latest.author.name,
    text: noteSnippet(latest),
    time: latest.time,
  };
}

function hostRecord(people: RoomPerson[], phase: RoomPhase): RoomRecord {
  if (phase.kind === "live") return { face: "live" };
  if (phase.kind === "paused") return { face: "paused" };
  if (phase.kind === "reconnecting") {
    return { face: "idle", disabledReason: "Reconnecting" };
  }
  const joining = people.find((person) => person.presence === "joining");
  return joining && phase.kind === "waiting"
    ? {
        face: "idle",
        disabledReason: `Waiting for ${joining.person.name} to join`,
      }
    : { face: "idle" };
}

function savingLine(phase: Extract<RoomPhase, { kind: "saving" }>): string {
  const percent = savingPercent(phase);
  return percent === null
    ? `Saving · ${phase.savedPeople} of ${phase.totalPeople} · keep this page open`
    : `Saving · ${percent}% · keep this page open`;
}

function roomDock(role: RoomRole, phase: RoomPhase): RoomDock {
  const saving = phase.kind === "saving" && !phase.failed ? phase : null;
  if (role !== "guest") {
    return saving
      ? { kind: "status", text: savingLine(saving) }
      : { kind: "controls" };
  }
  if (saving) {
    return {
      kind: "status",
      text: savingLine(saving),
      leaveHeld: LEAVE_WHILE_SAVING_REASON,
    };
  }
  switch (phase.kind) {
    case "live":
    case "paused":
    case "reconnecting":
      return { kind: "controls", leaveHeld: LEAVE_DURING_TAKE_REASON };
    case "saved":
      return { kind: "done", text: SAVED_DOCK_LINE };
    default:
      return { kind: "controls" };
  }
}

export function gridColumns(
  viewerWidth: ViewerWidth,
  tiles: number,
): 1 | 2 | 3 | 4 {
  if (viewerWidth === "desktop") {
    return tiles > 1 ? 2 : 1;
  }
  return viewerWidth === "phone-landscape"
    ? (Math.min(4, Math.max(1, tiles)) as 1 | 2 | 3 | 4)
    : 2;
}

export function roomViewModel(input: RoomViewInput): RoomViewModel {
  const { role, people, phase, viewerWidth } = input;

  const hostInvites = role === "host" && input.invite !== false;
  const recorded = people.filter(
    (person) => isRecorded(person) && !(hostInvites && isGone(person, phase)),
  );
  // The host leads with their own tile everywhere; a guest only on the phone.
  const ordered =
    role === "host" || isPhoneWidth(viewerWidth)
      ? ownFirst(recorded)
      : recorded;
  const tiles: RoomTileEntry[] = ordered.map((entry) => ({
    key: personKey(entry),
    kind: "person",
    props: tileProps(entry),
  }));
  if (hostInvites) {
    const open = Math.max(0, RECORDED_CAP - tiles.length);
    for (let slot = 1; slot <= open; slot += 1) {
      tiles.push({ key: `invite-${slot}`, kind: "invite" });
    }
  }

  const listeners = people
    .filter((person) => person.role === "producer")
    .map((person) => ({
      key: personKey(person),
      person: person.person,
      label: person.you ? "You" : undefined,
    }));

  const desktop = viewerWidth === "desktop";
  const railOpen = desktop && (input.notesOpen ?? role === "producer");
  const sheetOpen = !desktop && (input.notesOpen ?? false);
  const peek =
    viewerWidth === "phone"
      ? notePeek(input.notes ?? [], role, input.selfName ?? "")
      : null;
  const columns = gridColumns(viewerWidth, tiles.length);

  const derived = role === "guest" ? hostOffline(people) : [];
  return {
    tiles,
    columns,
    listeners,
    dockSeat: role,
    showComment:
      phase.kind === "live" ||
      phase.kind === "paused" ||
      phase.kind === "reconnecting",
    railOpen,
    sheetOpen,
    notesOpen: railOpen || sheetOpen,
    peek,
    record:
      role === "host" && input.canRecord === true
        ? hostRecord(people, phase)
        : null,
    dock: roomDock(role, phase),
    alerts: [...derived, ...(input.alerts ?? [])],
  };
}
