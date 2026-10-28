import type { ShellBreakpoint } from "../state/types";
import type { CoverProps } from "../system/Cover";
import type { JoinMic } from "../system/joinSheetModel";
import type { RoomAlertInput } from "../system/roomAlertModel";
import type { RoomPhase } from "../system/roomPhase";
import type { RoomSaving } from "../system/roomTileModel";
import type { RoomRole, ViewerWidth } from "../system/roomViewModel";
import { dbToFraction } from "../ui/metering";
import { hostRoomPhase } from "./hostRoomPhase";
import type { MicPermissionStatus } from "./micPermission";
import {
  type RoomAlertActions,
  type RoomAlertSource,
  roomAlerts,
} from "./roomAlerts";
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

export function guestRoomPhase(
  snapshot: RecordSnapshot | null,
  options: {
    elapsedSinceSnapshotMs?: number;
    upload?: RecordUploadProgress | null;
    /** False for a guest who is not in the take: nothing of theirs is saving. */
    tookPart?: boolean;
  } = {},
): RoomPhase {
  const phase = hostRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: options.elapsedSinceSnapshotMs,
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
    detail?: string;
  },
): JoinMic {
  if (mic.status === "granted" && mic.stream) {
    const device =
      mic.devices.find((entry) => entry.deviceId === options.deviceId) ??
      mic.devices[0];
    const ready: JoinMic = {
      status: "ready",
      input: device?.label || "Microphone",
      level: dbToFraction(options.levelDb),
      clipped: options.clipped,
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
    return options.detail
      ? { status: "lost", detail: options.detail }
      : { status: "lost" };
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

export function guestRoomAlerts(
  source: Omit<RoomAlertSource, "hydrateError"> & {
    dropped?: boolean;
    notice?: string | null;
  },
  actions: RoomAlertActions = {},
  host?: string,
): RoomAlertInput[] {
  const { dropped, notice, ...rest } = source;
  const alerts = roomAlerts({ ...rest, hydrateError: null }, actions);
  if (dropped) {
    alerts.unshift({ kind: "host-offline", name: host });
  }
  if (notice) {
    alerts.push({ kind: "notice", message: notice });
  }
  return alerts;
}

export function savingStatus(
  upload: RecordUploadProgress | null | undefined,
): string | null {
  if (!upload || upload.fileAck || upload.error || upload.total <= 0) {
    return null;
  }
  const percent = Math.min(
    100,
    Math.floor((upload.acked / upload.total) * 100),
  );
  return `Saving · ${percent}% · keep this page open`;
}

type CoverSource = {
  bootError: string | null;
  error: string | null;
  accessEnded: boolean;
  inviteClosed: boolean;
  captureSettled: boolean;
  keeperActions: KeeperRecoveryActions;
  host?: string;
  onRetry?: () => void;
};

const page = { size: "page" } as const;

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
    if (source.inviteClosed) {
      return {
        ...page,
        glyph: "door-open",
        title: "Invite link closed",
        children: `${capitalized(host)} closed this invite link. Ask for a new link.`,
      };
    }
    const { download, recover } = source.keeperActions;
    if (source.captureSettled && (download || recover)) {
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
    return {
      ...page,
      glyph: "door-open",
      title: "This session has ended",
      children: source.captureSettled
        ? "Thanks for recording."
        : "Finishing your full-quality recording…",
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
  | "captureSettled"
  | "keeperActions"
  | "snapshot"
>;

/** The page-sized Cover this room needs instead of the room, or null. */
export function guestCoverProps(
  room: CoverRoom,
  onRetry: () => void,
): CoverProps | null {
  // Before the first take there is nothing on this device to save.
  const recorded = (room.snapshot?.take_index ?? -1) >= 0;
  const cover = guestCovers({
    bootError: room.bootError,
    error: room.error,
    accessEnded: room.accessEnded,
    inviteClosed: room.inviteClosed,
    captureSettled: room.captureSettled,
    keeperActions: recorded
      ? room.keeperActions
      : { ...room.keeperActions, download: undefined, recover: undefined },
    host: guestHostName(room.snapshot),
    onRetry,
  });
  if (!cover) {
    return null;
  }
  return cover;
}
