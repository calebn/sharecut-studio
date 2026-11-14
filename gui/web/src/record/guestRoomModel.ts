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
import type { BootFailure } from "./recordBootstrap";
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

/**
 * Whether the server's acknowledgement covers everything this device holds. It
 * counts only for the segments its pass saw, and the pass already forgets an
 * acknowledgement given for another take.
 */
export function uploadAcknowledged(
  upload: Pick<RecordUploadProgress, "fileAck" | "seenSegments">,
  localSegments: number,
): boolean {
  return upload.fileAck && localSegments <= upload.seenSegments;
}

function uploadStuck(upload: RecordUploadProgress): boolean {
  return (
    Boolean(upload.error) ||
    (upload.recoverable && !upload.uploading && !upload.pending)
  );
}

export function uploadInFlight(
  upload: RecordUploadProgress | null,
  localSegments: number,
): boolean {
  return (
    upload !== null &&
    !uploadAcknowledged(upload, localSegments) &&
    !uploadStuck(upload) &&
    (upload.pending || upload.uploading || upload.total > 0)
  );
}

export function guestRoomPhase(
  snapshot: RecordSnapshot | null,
  options: {
    elapsedSinceSnapshotMs?: number;
    upload?: RecordUploadProgress | null;
    /** Segments this device holds for the take. */
    localSegments?: number;
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
  const localSegments = options.localSegments ?? 0;
  const acknowledged =
    upload !== null &&
    upload !== undefined &&
    uploadAcknowledged(upload, localSegments);
  if (snapshot?.state === "stopped" && upload) {
    if (acknowledged) {
      return { kind: "saved" };
    }
    if (uploadStuck(upload)) {
      return { kind: "saving", savedPeople: 0, totalPeople: 1, failed: true };
    }
    if (uploadInFlight(upload, localSegments)) {
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
    if (!upload || acknowledged) {
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

export function guestRoomAlerts(
  source: Omit<RoomAlertSource, "hydrateError"> & {
    phase: RoomPhase;
    inTake: boolean;
    notice?: string | null;
  },
  actions: RoomAlertActions = {},
): RoomAlertInput[] {
  const { phase, inTake, notice, ...rest } = source;
  const alerts = roomAlerts({ ...rest, hydrateError: null }, actions);
  if (inTake && phase.kind === "reconnecting" && !phase.paused) {
    alerts.push({ kind: "connection-lost" });
  }
  if (notice) {
    alerts.push({ kind: "notice", message: notice });
  }
  return alerts;
}

type GuestStake = "finishing" | "saved" | "unsent" | "none";

function guestStake(
  phase: RoomPhase,
  device: {
    producer: boolean;
    captureSettled: boolean;
    keeperActions: Pick<KeeperRecoveryActions, "download" | "recover">;
  },
): GuestStake {
  if (device.producer) {
    return "none";
  }
  if (!device.captureSettled) {
    return "finishing";
  }
  if (phase.kind === "saved") {
    return "saved";
  }
  return device.keeperActions.download || device.keeperActions.recover
    ? "unsent"
    : "none";
}

type CoverSource = {
  bootError: BootFailure | null;
  error: string | null;
  accessEnded: boolean;
  inviteClosed: boolean;
  left: boolean;
  stake: GuestStake;
  keeperActions: KeeperRecoveryActions;
  host?: string;
  onRetry?: () => void;
};

const page = { size: "page" } as const;

const SAVING_LABEL = "Saving…";

function unsentRecordingCover(source: CoverSource, host: string): CoverProps {
  if (source.keeperActions.downloaded) {
    return downloadedCover(source.keeperActions, host);
  }
  const { download, recover } = source.keeperActions;
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
          busyLabel: runningLabel(source.keeperActions, "download"),
        }
      : undefined,
    secondary: recover
      ? {
          label: "Try saving again",
          onClick: recover,
          busy: source.keeperActions.busy,
          busyLabel: runningLabel(source.keeperActions, "recover"),
        }
      : undefined,
  };
}

type BootCover = Pick<CoverProps, "glyph" | "title" | "children"> & {
  retry: boolean;
};

const BOOT_COVERS: Record<BootFailure, BootCover> = {
  "not-found": {
    glyph: "octagon-alert",
    title: "This link doesn't open a room",
    children: "Ask the person who invited you for a new link.",
    retry: false,
  },
  network: {
    glyph: "cloud-off",
    title: "Couldn't reach the room",
    children:
      "Check your internet connection, then try again. If it keeps happening, let the person who invited you know.",
    retry: true,
  },
  server: {
    glyph: "triangle-alert",
    title: "The room didn't answer",
    children:
      "Try again in a minute. If it keeps happening, let the person who invited you know.",
    retry: true,
  },
};

function runningLabel(
  actions: KeeperRecoveryActions,
  kind: "download" | "recover",
): string | undefined {
  return actions.running === kind ? SAVING_LABEL : undefined;
}

export function guestCovers(source: CoverSource): CoverProps | null {
  const host = source.host?.trim() || "the host";
  if (source.bootError) {
    const { retry, ...copy } = BOOT_COVERS[source.bootError];
    return {
      ...page,
      ...copy,
      primary:
        retry && source.onRetry
          ? { label: "Try again", onClick: source.onRetry }
          : undefined,
    };
  }
  if (source.accessEnded && source.keeperActions.downloaded) {
    return downloadedCover(source.keeperActions, host);
  }
  if (source.accessEnded) {
    const { download, recover } = source.keeperActions;
    if (source.inviteClosed) {
      const hasLocal = source.stake === "unsent";
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
                busyLabel: runningLabel(source.keeperActions, "download"),
              }
            : undefined,
        secondary:
          hasLocal && recover
            ? {
                label: "Try saving again",
                onClick: recover,
                busy: source.keeperActions.busy,
                busyLabel: runningLabel(source.keeperActions, "recover"),
              }
            : undefined,
      };
    }
    if (source.stake === "unsent") {
      return unsentRecordingCover(source, host);
    }
    return {
      ...page,
      glyph: "door-open",
      title: "This session has ended",
      children:
        source.stake === "finishing"
          ? "Finishing your full-quality recording…"
          : "Thanks for recording.",
    };
  }
  if (source.left) {
    if (source.stake === "unsent") {
      return unsentRecordingCover(source, host);
    }
    const finishing = source.stake === "finishing";
    return {
      ...page,
      glyph: "door-open",
      title: "You left the room",
      children: finishing
        ? "Finishing your full-quality recording…"
        : source.stake === "saved"
          ? `Your recording is saved to ${host}'s project. You can close this page.`
          : "You can close this page.",
      primary:
        source.onRetry && !finishing
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

function downloadedCover(
  actions: KeeperRecoveryActions,
  host: string,
): CoverProps {
  return {
    ...page,
    glyph: "download",
    title: "Check your downloads",
    children: `Look for the zip file of your recording and send it to ${host}. If it isn't there, save it again.`,
    secondary: actions.download
      ? {
          label: "Save it again",
          onClick: actions.download,
          busy: actions.busy,
          busyLabel: runningLabel(actions, "download"),
        }
      : undefined,
  };
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The guest's own tile after Stop: how far their upload has come. */
export function ownSaving(
  upload: RecordUploadProgress | null | undefined,
  localSegments: number,
): RoomSaving | null {
  if (!upload) {
    return null;
  }
  if (uploadAcknowledged(upload, localSegments)) {
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
  | "producer"
  | "captureSettled"
  | "keeperActions"
  | "localRecording"
  | "localSegments"
  | "snapshot"
> & { upload: Pick<RecordUploadProgress, "fileAck" | "seenSegments"> };

/** The page-sized Cover this room needs instead of the room, or null. */
export function guestCoverProps(
  room: CoverRoom,
  options: { onRetry: () => void; phase: RoomPhase },
): CoverProps | null {
  // Before the first take, or once the server has acknowledged every segment
  // the device holds, there is nothing here to save: whatever the device still
  // holds (a copy kept for the reclaim grace after a download) is a duplicate.
  const hasLocalCopy =
    (room.snapshot?.take_index ?? -1) >= 0 &&
    room.localRecording &&
    !uploadAcknowledged(room.upload, room.localSegments);
  const keeperActions = hasLocalCopy
    ? room.keeperActions
    : {
        ...room.keeperActions,
        download: undefined,
        recover: undefined,
        downloaded: false,
      };
  return guestCovers({
    bootError: room.bootError,
    error: room.error,
    accessEnded: room.accessEnded,
    inviteClosed: room.inviteClosed,
    left: room.left,
    stake: guestStake(options.phase, {
      producer: room.producer,
      captureSettled: room.captureSettled,
      keeperActions,
    }),
    keeperActions,
    host: guestHostName(room.snapshot),
    onRetry: options.onRetry,
  });
}
