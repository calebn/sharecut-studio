import {
  LOCAL_KEEPER_PENDING_COPY,
  type RecordRoomState,
  type RecordSnapshot,
} from "./types";
import type { RecordUploadStatus } from "./upload/transport";

/** The one take control each room state offers; Stop only exists while a take is open. */
export const TAKE_CONTROL = {
  lobby: { commandId: "record.start", label: "Start", stop: false },
  stopped: { commandId: "record.start", label: "Start", stop: false },
  recording: { commandId: "record.pause", label: "Pause", stop: true },
  paused: { commandId: "record.resume", label: "Resume", stop: true },
} as const satisfies Record<
  RecordRoomState,
  { commandId: string; label: string; stop: boolean }
>;

export const STOP_CONFIRM_COPY =
  "Stop this take? Recording ends for everyone in the room.";

/** A host Start blocker with its words. */
export type StartBlockerItem = {
  key: string;
  text: string;
};

export type LocalStartReadiness = {
  /** The host's local recording storage passed its preflight. */
  storageReady: boolean;
  /** Why the storage preflight failed, if it did. */
  storageError: string | null;
  capturingRoomTone: boolean;
};

/**
 * Everything that keeps Start disabled, worded for the host. Server blockers
 * come first (who the room is waiting for), then this device's own readiness.
 */
export function startBlockerItems(
  snapshot: RecordSnapshot,
  local: LocalStartReadiness,
): StartBlockerItem[] {
  const items: StartBlockerItem[] = (snapshot.start_blockers ?? []).map(
    (blocker) =>
      blocker.code === "no_recorder"
        ? { key: "no_recorder", text: "Joining the room." }
        : {
            key: `consent:${blocker.participant_id}`,
            text: `Waiting for ${blocker.display_name || "a guest"} to accept recording.`,
          },
  );
  if (local.storageError) {
    items.push({ key: "storage", text: local.storageError });
  } else if (!local.storageReady) {
    items.push({ key: "storage", text: LOCAL_KEEPER_PENDING_COPY });
  }
  if (local.capturingRoomTone) {
    items.push({
      key: "room_tone",
      text: "Recording room tone. Start is available when it finishes.",
    });
  }
  return items;
}

/** Whether Land can succeed now; when it cannot, the reason shown beside it. */
export type LandGate =
  | { enabled: true; label: "Land" | "Retry land" }
  | { enabled: false; label: "Land"; reason: string };

/**
 * `segments` is the host's upload status for every participant, or null when
 * the caller has not read it (keyboard and palette), which gates on room state
 * only and lets the server report an empty land.
 */
export function landGate(
  snapshot: RecordSnapshot,
  segments: RecordUploadStatus["segments"] | null,
): LandGate {
  if (snapshot.take_index < 0) {
    return { enabled: false, label: "Land", reason: "Record a take first." };
  }
  if (snapshot.state === "recording" || snapshot.state === "paused") {
    return {
      enabled: false,
      label: "Land",
      reason: "Stop the take to land it on the timeline.",
    };
  }
  if (segments === null) {
    return { enabled: true, label: "Land" };
  }
  if (segments.some((row) => row.land_failed)) {
    return { enabled: true, label: "Retry land" };
  }
  const waiting = segments.some((row) => row.file_ack && !row.landed);
  if (waiting || (snapshot.comments?.length ?? 0) > 0) {
    return { enabled: true, label: "Land" };
  }
  if (segments.some((row) => !row.file_ack)) {
    return {
      enabled: false,
      label: "Land",
      reason: "Recordings are still saving to the project.",
    };
  }
  if (segments.length === 0) {
    return {
      enabled: false,
      label: "Land",
      reason: "No recordings have reached the project yet.",
    };
  }
  return {
    enabled: false,
    label: "Land",
    reason: "Every take is on the timeline.",
  };
}
