import type { ShellBreakpoint } from "../state/types";
import type { CoverProps } from "../system/Cover";
import type { JoinMic } from "../system/joinSheetModel";
import type { RoomAlertInput } from "../system/roomAlertModel";
import { clockText, type RoomPhase } from "../system/roomPhase";
import type { RoomSaving } from "../system/roomTileModel";
import type { RoomRole, ViewerWidth } from "../system/roomViewModel";
import type { TakeInput, TakeLineInput } from "../system/takesTrayModel";
import { dbToFraction } from "../ui/metering";
import { hostRoomPhase } from "./hostRoomPhase";
import type { TakeClipping } from "./keeper/clipRegions";
import type { MicPermissionStatus } from "./micPermission";
import {
  type RoomAlertActions,
  type RoomAlertSource,
  roomAlerts,
} from "./roomAlerts";
import type { SegmentSave } from "./saveStatus";
import type { RecordParticipant, RecordSnapshot } from "./types";
import type { KeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import type { RecordUploadProgress } from "./upload/useRecordUpload";
import type { GuestRoom } from "./useGuestRoom";

export function isNotFound(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("invalid") ||
    lower.includes("revoked") ||
    lower.includes("not found")
  );
}

const LOST_STATUSES: readonly MicPermissionStatus[] = [
  "lost",
  "unavailable",
  "error",
];

export function guestHostName(snapshot: RecordSnapshot | null): string {
  return (
    snapshot?.participants.find(
      (participant) => participant.role === "host" && !participant.removed,
    )?.display_name ?? ""
  );
}

function uploadPercent(upload: RecordUploadProgress): number | undefined {
  return upload.total > 0
    ? Math.min(100, Math.floor((upload.acked / upload.total) * 100))
    : undefined;
}

function hasOwnUpload(upload: RecordUploadProgress | null | undefined) {
  return Boolean(
    upload &&
      (upload.fileAck ||
        upload.pending ||
        upload.uploading ||
        upload.recoverable ||
        upload.total > 0 ||
        upload.error),
  );
}

/** Whether this guest is on the current take's roster, as far as it is known. */
export function tookPart(
  snapshot: RecordSnapshot | null,
  me: RecordParticipant | null,
): boolean {
  if (!snapshot || me?.consented !== true) {
    return false;
  }
  const roster =
    snapshot.takes?.find((take) => take.take_index === snapshot.take_index)
      ?.consented_participant_ids ?? [];
  return roster.length === 0 || roster.includes(me.participant_id);
}

function ownLine(saves: readonly SegmentSave[]): TakeLineInput {
  if (saves.length > 0 && saves.every((save) => save.state === "saved")) {
    return { kind: "saved" };
  }
  const total = saves.reduce((sum, save) => sum + (save.chunks?.total ?? 0), 0);
  const done = saves.reduce((sum, save) => sum + (save.chunks?.acked ?? 0), 0);
  return total > 0
    ? { kind: "saving", done, total }
    : { kind: "saving", done: 0, total: 1 };
}

/**
 * The guest's Takes tray: the finished takes in which their own mic clipped,
 * each with only their own line. A clean take is not listed, and nobody
 * else's clipping is ever read here.
 */
export function guestTakes(
  snapshot: RecordSnapshot | null,
  me: RecordParticipant | null,
  saves: readonly SegmentSave[],
  clippings: Readonly<Record<number, TakeClipping>>,
): TakeInput[] {
  if (!snapshot || me?.consented !== true) {
    return [];
  }
  const colorIndex = Math.max(
    0,
    snapshot.participants.findIndex(
      (person) => person.participant_id === me.participant_id,
    ),
  );
  const takes: TakeInput[] = [];
  for (const take of snapshot.takes ?? []) {
    const clipping = clippings[take.take_index];
    const open =
      take.take_index === snapshot.take_index && snapshot.state !== "stopped";
    if (
      open ||
      !clipping ||
      clipping.regions.length === 0 ||
      !take.consented_participant_ids.includes(me.participant_id)
    ) {
      continue;
    }
    const end = take.stopped_wall_ms ?? take.session_start_wall_ms;
    const paused = take.pauses.reduce(
      (sum, pause) =>
        sum + Math.max(0, (pause.resume_wall_ms ?? end) - pause.pause_wall_ms),
      0,
    );
    takes.push({
      id: `take-${take.take_index}`,
      number: take.take_index + 1,
      lengthSec: Math.max(
        0,
        (end - take.session_start_wall_ms - paused) / 1000,
      ),
      people: [
        {
          person: { name: me.display_name, colorIndex },
          line: ownLine(saves.filter((save) => save.take === take.take_index)),
          clipTimes: clipping.regions.map((region) =>
            clockText(region.startMs / 1000),
          ),
          clipTruncated: clipping.truncated,
        },
      ],
    });
  }
  return takes;
}

export function guestRoomPhase(
  snapshot: RecordSnapshot | null,
  options: {
    elapsedSinceSnapshotMs?: number;
    upload?: RecordUploadProgress | null;
    /** False for a guest who is not in the take: nothing of theirs is saving. */
    tookPart?: boolean;
    /** This page's room socket is open. Defaults to true. False on air reads reconnecting. */
    connected?: boolean;
  } = {},
): RoomPhase {
  const phase = hostRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: options.elapsedSinceSnapshotMs,
    dropped: options.connected === false,
  });
  const { upload } = options;
  if (snapshot?.state === "stopped" && upload) {
    if (upload.fileAck) {
      return { kind: "saved" };
    }
    // Stopped on a failed upload, or on a partial take that needs Finish saving.
    const stuck =
      Boolean(upload.error) ||
      (upload.recoverable && !upload.uploading && !upload.pending);
    if (stuck) {
      return { kind: "saving", savedPeople: 0, totalPeople: 1, failed: true };
    }
    if (upload.pending || upload.uploading || upload.total > 0) {
      return {
        kind: "saving",
        savedPeople: 0,
        totalPeople: 1,
        percent: uploadPercent(upload),
      };
    }
  }
  const idle =
    snapshot?.state === "stopped" &&
    options.tookPart === false &&
    !hasOwnUpload(upload);
  if (phase.kind === "waiting" || idle) {
    const host = guestHostName(snapshot);
    return host ? { kind: "waiting", host } : { kind: "waiting" };
  }
  if (phase.kind === "saving" || phase.kind === "saved") {
    if (!upload || upload.fileAck) {
      return { kind: "saved" };
    }
    return { kind: "saving", savedPeople: 0, totalPeople: 1 };
  }
  return phase;
}

export function joinHere(
  snapshot: RecordSnapshot | null,
  me: RecordParticipant | null,
): { person: { name: string; colorIndex: number }; role: RoomRole }[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.participants.flatMap((participant, index) =>
    participant.removed ||
    !participant.connected ||
    participant.participant_id === me?.participant_id
      ? []
      : [
          {
            person: { name: participant.display_name, colorIndex: index },
            role: participant.role,
          },
        ],
  );
}

export function joinMic(
  mic: {
    status: MicPermissionStatus;
    stream: MediaStream | null;
    devices: readonly MediaDeviceInfo[];
  },
  options: {
    deviceId: string;
    levelDb: number;
    clipped?: boolean;
    inputLocked?: boolean;
    switching?: boolean;
    detail?: string;
  },
): JoinMic {
  const switching =
    !!options.switching &&
    !mic.stream &&
    (mic.status === "prompting" ||
      mic.status === "idle" ||
      mic.status === "granted") &&
    mic.devices.length > 1;
  if ((mic.status === "granted" && mic.stream) || switching) {
    const device =
      mic.devices.find((entry) => entry.deviceId === options.deviceId) ??
      mic.devices[0];
    const ready: JoinMic = {
      status: "ready",
      input: device?.label || "Microphone",
      level: dbToFraction(options.levelDb),
      clipped: options.clipped,
      switching: switching || undefined,
    };
    if (mic.devices.length > 1) {
      ready.devices = mic.devices.map((entry) => ({
        id: entry.deviceId,
        label: entry.label || "Microphone",
      }));
      ready.inputId = options.deviceId;
      ready.inputLocked = options.inputLocked;
    }
    return ready;
  }
  if (mic.status === "prompting") {
    return { status: "prompting" };
  }
  if (mic.status === "denied") {
    return { status: "denied" };
  }
  if (LOST_STATUSES.includes(mic.status)) {
    const lost: JoinMic = { status: "lost" };
    if (options.detail) lost.detail = options.detail;
    if (mic.devices.length > 0) {
      lost.devices = mic.devices.map((entry) => ({
        id: entry.deviceId,
        label: entry.label || "Microphone",
      }));
      lost.inputId = options.deviceId;
      lost.inputLocked = options.inputLocked;
    }
    return lost;
  }
  return { status: "idle" };
}

export function guestViewerWidth(
  shell: ShellBreakpoint,
  landscape: boolean,
): ViewerWidth {
  if (shell !== "phone") {
    return "desktop";
  }
  return landscape ? "phone-landscape" : "phone";
}

/** The guest and producer alerts. The host-offline alert is derived from the roster by roomViewModel. */
export function guestRoomAlerts(
  source: Omit<RoomAlertSource, "hydrateError"> & {
    phase: RoomPhase;
    recorded: boolean;
    notice?: string | null;
  },
  actions: RoomAlertActions = {},
): RoomAlertInput[] {
  const { phase, recorded, notice, ...rest } = source;
  const alerts = roomAlerts({ ...rest, hydrateError: null }, actions);
  if (recorded && phase.kind === "reconnecting" && !phase.paused) {
    alerts.push({ kind: "connection-lost" });
  }
  if (notice) {
    alerts.push({ kind: "notice", message: notice });
  }
  return alerts;
}

/** What a viewer who left still has at stake. */
type LeftWith = "nothing" | "saved" | "unsaved";

function leftWith(phase: RoomPhase, recorded: boolean): LeftWith {
  if (!recorded) {
    return "nothing";
  }
  if (phase.kind === "saved") {
    return "saved";
  }
  return phase.kind === "saving" ? "unsaved" : "nothing";
}

type CoverSource = {
  bootError: string | null;
  error: string | null;
  accessEnded: boolean;
  inviteClosed: boolean;
  /** Set once this viewer pressed Leave or Done. */
  left: LeftWith | null;
  captureSettled: boolean;
  keeperActions: KeeperRecoveryActions;
  host?: string;
  onRetry?: () => void;
};

const page = { size: "page" } as const;

function unsentRecordingCover(
  source: CoverSource,
  host: string,
): CoverProps | null {
  const { download, recover } = source.keeperActions;
  if (!source.captureSettled || !(download || recover)) {
    return null;
  }
  return {
    ...page,
    glyph: "door-open",
    title: "Your recording didn't finish saving",
    children: `It's safe on this device. Save it and send it to ${host}.`,
    primary: download
      ? {
          label: "Save my recording",
          onClick: download,
          busy: source.keeperActions.busy,
        }
      : undefined,
    secondary: recover
      ? { label: "Try saving again", onClick: recover }
      : undefined,
  };
}

/**
 * Precedence: boot error, access ended, left, room full. A viewer who left with
 * an unsent local copy gets the unsent-recording cover; otherwise the left
 * cover says what happened to their recording. Join again remounts the session,
 * which rejoins through the cached lease.
 */
export function guestCovers(source: CoverSource): CoverProps | null {
  const host = source.host?.trim() || "the host";
  if (source.bootError) {
    return isNotFound(source.bootError)
      ? {
          ...page,
          glyph: "octagon-alert",
          title: "This link doesn't open a room",
          children: "Ask the person who invited you for a new link.",
        }
      : {
          ...page,
          glyph: "octagon-alert",
          title: "This link does not work",
          children: source.bootError,
        };
  }
  if (source.accessEnded) {
    const { download, recover } = source.keeperActions;
    if (source.inviteClosed) {
      const hasLocal = source.captureSettled && (download || recover);
      return {
        ...page,
        glyph: "door-open",
        title: "Invite link closed",
        children: hasLocal
          ? `${capitalized(host)} closed this invite link. Your recording is safe on this device. Save it and send it to ${host}, or ask for a new link.`
          : `${capitalized(host)} closed this invite link. Ask for a new link.`,
        primary:
          hasLocal && download
            ? {
                label: "Save my recording",
                onClick: download,
                busy: source.keeperActions.busy,
              }
            : undefined,
        secondary:
          hasLocal && recover
            ? { label: "Try saving again", onClick: recover }
            : undefined,
      };
    }
    const unsent = unsentRecordingCover(source, host);
    if (unsent) {
      return unsent;
    }
    return {
      ...page,
      glyph: "door-open",
      title: "This session has ended",
      children: source.captureSettled
        ? "Thanks for recording."
        : "Finishing your full-quality recording…",
    };
  }
  if (source.left) {
    const unsent =
      source.left === "unsaved" ? unsentRecordingCover(source, host) : null;
    if (unsent) {
      return unsent;
    }
    return {
      ...page,
      glyph: "door-open",
      title: "You left the room",
      children:
        source.left === "saved"
          ? `Your recording is saved to ${host}'s project. You can close this page.`
          : "You can close this page.",
      primary: source.onRetry
        ? { label: "Join again", onClick: source.onRetry }
        : undefined,
    };
  }
  if (source.error === "room_full") {
    return {
      ...page,
      glyph: "user",
      title: "The room is full",
      children: `Ask ${host} to make space or send you a new link.`,
      primary: source.onRetry
        ? { label: "Try again", onClick: source.onRetry }
        : undefined,
    };
  }
  return null;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The guest's own tile after Stop: how far their upload has come. */
export function ownSaving(
  upload: RecordUploadProgress | null | undefined,
): RoomSaving | null {
  if (!upload) {
    return null;
  }
  if (upload.fileAck) {
    return "saved";
  }
  if (upload.error) {
    return "failed";
  }
  return upload.total > 0 ? { done: upload.acked, total: upload.total } : null;
}

type CoverRoom = Pick<
  GuestRoom,
  | "bootError"
  | "error"
  | "accessEnded"
  | "inviteClosed"
  | "left"
  | "captureSettled"
  | "keeperActions"
  | "localRecording"
  | "snapshot"
>;

/** The page-sized Cover this room needs instead of the room, or null. */
export function guestCoverProps(
  room: CoverRoom,
  options: { onRetry: () => void; phase: RoomPhase; recorded: boolean },
): CoverProps | null {
  // Before the first take, or once every segment has landed and been cleared
  // from this device, there is nothing here to save.
  const hasLocalCopy =
    (room.snapshot?.take_index ?? -1) >= 0 && room.localRecording;
  const cover = guestCovers({
    bootError: room.bootError,
    error: room.error,
    accessEnded: room.accessEnded,
    inviteClosed: room.inviteClosed,
    left: room.left ? leftWith(options.phase, options.recorded) : null,
    captureSettled: room.captureSettled,
    keeperActions: hasLocalCopy
      ? room.keeperActions
      : { ...room.keeperActions, download: undefined, recover: undefined },
    host: guestHostName(room.snapshot),
    onRetry: options.onRetry,
  });
  if (!cover) {
    return null;
  }
  return cover;
}
