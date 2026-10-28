import type { ShellBreakpoint } from "../state/types";
import type { CoverProps } from "../system/Cover";
import type { JoinMic } from "../system/joinSheetModel";
import type { RoomAlertInput } from "../system/roomAlertModel";
import type { RoomPhase } from "../system/roomPhase";
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

export function guestRoomPhase(
  snapshot: RecordSnapshot | null,
  options: {
    elapsedSinceSnapshotMs?: number;
    upload?: RecordUploadProgress | null;
  } = {},
): RoomPhase {
  const phase = hostRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: options.elapsedSinceSnapshotMs,
  });
  if (phase.kind === "waiting") {
    const host = guestHostName(snapshot);
    return host ? { kind: "waiting", host } : phase;
  }
  if (phase.kind === "saving" || phase.kind === "saved") {
    if (!options.upload || options.upload.fileAck) {
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
  options: { deviceId: string; levelDb: number; clipped?: boolean },
): JoinMic {
  if (mic.status === "granted" && mic.stream) {
    const device =
      mic.devices.find((entry) => entry.deviceId === options.deviceId) ??
      mic.devices[0];
    return {
      status: "ready",
      input: device?.label || "Microphone",
      level: dbToFraction(options.levelDb),
      clipped: options.clipped,
    };
  }
  if (mic.status === "prompting") {
    return { status: "prompting" };
  }
  if (mic.status === "denied") {
    return { status: "denied" };
  }
  if (LOST_STATUSES.includes(mic.status)) {
    return { status: "lost" };
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
  source: Omit<RoomAlertSource, "hydrateError"> & { dropped?: boolean },
  actions: RoomAlertActions = {},
  host?: string,
): RoomAlertInput[] {
  const { dropped, ...rest } = source;
  const alerts = roomAlerts({ ...rest, hydrateError: null }, actions);
  if (dropped) {
    alerts.unshift({ kind: "host-offline", name: host });
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
          ? { label: "Save my recording", onClick: download }
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
