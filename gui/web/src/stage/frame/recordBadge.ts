import {
  type CaptureHealth,
  type HostRoom,
  hostRoomPhase,
  recordingClockMs,
  roomAlerts,
} from "../../record";
import type { RecordBadge } from "../../system/StageBar";

type RecordBadgeRoom = Pick<
  HostRoom,
  | "snapshot"
  | "state"
  | "capture"
  | "host"
  | "sinkError"
  | "upload"
  | "transportError"
  | "hydrateError"
  | "takeClipping"
  | "hostSegments"
>;

type RecordBadgeSource = {
  captureHealth: CaptureHealth;
  /** `performance.now()` when the snapshot arrived; the live clock counts on from it. */
  receivedAtMs: number | null;
  /** The record socket closed after being open; a local clock is no longer the room's. */
  dropped: boolean;
  /** Alerts are the Record stage's own to show; away from it they earn a dot. */
  away: boolean;
};

const IDLE: RecordBadge = { kind: "idle" };

function waitingCount(room: RecordBadgeRoom): number {
  if (room.state !== "lobby") {
    return 0;
  }
  return (
    room.snapshot?.participants.filter(
      (person) =>
        person.role !== "host" &&
        person.role !== "producer" &&
        !person.removed &&
        person.connected &&
        person.consented !== false,
    ).length ?? 0
  );
}

/**
 * What the Record item says without being opened. A take outranks saving,
 * saving outranks people waiting; any active alert adds a dot to those, and
 * stands alone when nothing else is going on.
 */
export function recordBadge(
  room: RecordBadgeRoom,
  source: RecordBadgeSource,
): RecordBadge {
  const { snapshot, state } = room;
  if (!snapshot) {
    return IDLE;
  }
  const alert =
    source.away &&
    roomAlerts({
      state,
      captureHealth: source.captureHealth,
      keeperError: room.capture.keeperError ?? null,
      micLost: room.capture.micLost ?? false,
      sinkError: room.sinkError,
      uploadError: room.upload.error,
      recoverable: room.upload.recoverable && state === "stopped",
      monitorError: room.capture.monitorError ?? null,
      transportError: room.transportError,
      hydrateError: room.hydrateError,
      clipped: room.takeClipping?.regions.length ?? 0,
      muted: room.host?.muted ?? false,
      micCheckFailed: room.capture.micCheckFailed,
    }).length > 0;
  if (source.dropped && (state === "recording" || state === "paused")) {
    return { kind: "reconnecting", alert };
  }
  if (state === "recording") {
    return {
      kind: "live",
      clockMs: recordingClockMs(snapshot),
      receivedAtMs: source.receivedAtMs,
      alert,
    };
  }
  if (state === "paused") {
    return { kind: "paused", alert };
  }
  const phase = hostRoomPhase(snapshot, { segments: room.hostSegments });
  if (phase.kind === "saving") {
    return {
      kind: "saving",
      progress: phase.totalPeople
        ? phase.savedPeople / phase.totalPeople
        : undefined,
      alert,
    };
  }
  if (alert) {
    return { kind: "alert" };
  }
  const count = waitingCount(room);
  return count > 0 ? { kind: "waiting", count } : IDLE;
}
