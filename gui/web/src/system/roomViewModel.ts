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
  dockStatus: string | null;
  alerts: RoomAlertInput[];
};

export const isPhoneWidth = (width: ViewerWidth) => width !== "desktop";

/** The host's room holds at most four recorded people, the host included. */
const RECORDED_CAP = 4;

/** Producers listen; everyone else is recorded. */
const isRecorded = (person: RoomPerson) => person.role !== "producer";

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
  if (entry.presence !== "live") {
    return { presence: entry.presence, person: entry.person };
  }
  const flags = {
    presence: "live" as const,
    person: entry.person,
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

function savingStatus(phase: RoomPhase): string | null {
  if (phase.kind !== "saving") return null;
  const percent = savingPercent(phase);
  return percent === null
    ? `Saving · ${phase.savedPeople} of ${phase.totalPeople} · keep this page open`
    : `Saving · ${percent}% · keep this page open`;
}

export function roomViewModel(input: RoomViewInput): RoomViewModel {
  const { role, people, phase, viewerWidth } = input;

  const recorded = people.filter(isRecorded);
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
  if (role === "host" && input.invite !== false) {
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
  const columns = !desktop
    ? viewerWidth === "phone-landscape"
      ? (Math.min(4, Math.max(1, tiles.length)) as 1 | 2 | 3 | 4)
      : 2
    : tiles.length > 1
      ? 2
      : 1;

  // The derived alert is named, so it replaces a caller's nameless host-offline:
  // RoomAlert keeps the first alert of each kind.
  const derived = role === "guest" ? hostOffline(people) : [];
  const callers = (input.alerts ?? []).filter(
    (alert) => !(derived.length > 0 && alert.kind === "host-offline"),
  );
  return {
    tiles,
    columns,
    listeners,
    dockSeat: role,
    showComment: phase.kind !== "waiting",
    railOpen,
    sheetOpen,
    notesOpen: railOpen || sheetOpen,
    peek,
    record:
      role === "host" && input.canRecord === true
        ? hostRecord(people, phase)
        : null,
    dockStatus: savingStatus(phase),
    alerts: [...derived, ...callers],
  };
}
