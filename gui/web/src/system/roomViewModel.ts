import type { PersonData } from "./Person";
import type { DockSeat } from "./RecordDock";
import type { RoomAlertInput } from "./roomAlertModel";
import type { RoomPhase } from "./roomPhase";
import {
  effectiveLive,
  type RoomConnection,
  type RoomSaving,
  type RoomTileProps,
} from "./roomTileModel";

export type RoomRole = DockSeat;
export type ViewerWidth = "desktop" | "phone";

/** One person in the room as the viewer's client knows them. */
export type RoomPerson = {
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
};

type RoomListener = { key: string; person: PersonData; label?: string };

/** A person's tile, or an Invite slot the host can fill. */
type RoomTileEntry =
  | { key: string; kind: "person"; props: RoomTileProps }
  | { key: string; kind: "invite" };

type RoomViewModel = {
  tiles: RoomTileEntry[];
  /** 1 for a lone tile, otherwise two columns (a 2x2 for three or four). */
  columns: 1 | 2;
  listeners: RoomListener[];
  dockSeat: DockSeat;
  showComment: boolean;
  railOpen: boolean;
  alerts: RoomAlertInput[];
};

/** The host's room holds at most four recorded people, the host included. */
const RECORDED_CAP = 4;

/** Producers listen; everyone else is recorded. */
const isRecorded = (person: RoomPerson) => person.role !== "producer";

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

export function roomViewModel(input: RoomViewInput): RoomViewModel {
  const { role, people, phase, viewerWidth } = input;

  const recorded = people.filter(isRecorded);
  // The host leads with their own tile everywhere; a guest only on the phone.
  const ordered =
    role === "host" || viewerWidth === "phone" ? ownFirst(recorded) : recorded;
  const tiles: RoomTileEntry[] = ordered.map((entry) => ({
    key: `${entry.role}-${entry.person.name}`,
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
      key: `producer-${person.person.name}`,
      person: person.person,
      label: person.you ? "You" : undefined,
    }));

  const railOpen =
    viewerWidth === "desktop" && (input.notesOpen ?? role === "producer");

  // The derived alert is named, so it replaces a caller's nameless host-offline:
  // RoomAlert keeps the first alert of each kind.
  const derived = role === "guest" ? hostOffline(people) : [];
  const callers = (input.alerts ?? []).filter(
    (alert) => !(derived.length > 0 && alert.kind === "host-offline"),
  );
  return {
    tiles,
    columns: viewerWidth === "phone" || tiles.length > 1 ? 2 : 1,
    listeners,
    dockSeat: role,
    showComment: phase.kind !== "waiting",
    railOpen,
    alerts: [...derived, ...callers],
  };
}
