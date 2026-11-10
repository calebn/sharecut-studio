import { TAKE_REASON } from "./deviceSheet";
import { someoneAccepted } from "./hostRecording";
import {
  LOCAL_KEEPER_PENDING_COPY,
  type RecordRoomState,
  type RecordSnapshot,
} from "./types";
import type { RecordUploadStatus } from "./upload/transport";

/** The one take control each room state offers. */
export const TAKE_CONTROL = {
  lobby: { commandId: "record.start", label: "Start" },
  stopped: { commandId: "record.start", label: "Start" },
  recording: { commandId: "record.pause", label: "Pause" },
  paused: { commandId: "record.resume", label: "Resume" },
} as const satisfies Record<
  RecordRoomState,
  { commandId: string; label: string }
>;

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
  /** The host's own mic is off: this device has no storage or room tone to wait for. Absent counts as on. */
  hostMicOff?: boolean;
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
  if (local.hostMicOff) {
    if (items.length === 0 && !someoneAccepted(snapshot)) {
      items.push({
        key: "nobody_recording",
        text: "Your mic is off. Start is available when a guest has accepted.",
      });
    }
    return items;
  }
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

/** Whether `record.land` can run now; when it cannot, the reason. */
export type LandGate = { enabled: true } | { enabled: false; reason: string };

/** Room state only: the server reports an empty land and lands each segment on its file ACK. */
export function landGate(snapshot: RecordSnapshot): LandGate {
  if (snapshot.take_index < 0) {
    return { enabled: false, reason: "Record a take first." };
  }
  if (snapshot.state === "recording" || snapshot.state === "paused") {
    return {
      enabled: false,
      reason: "Stop the take to land it on the timeline.",
    };
  }
  return { enabled: true };
}

export type EndGate = { enabled: true } | { enabled: false; reason: string };

/**
 * Ending revokes the guests' links for good, so unsaved recordings and takes
 * not yet on the timeline would be stranded: End waits until each is landed.
 */
export function endGate(
  snapshot: RecordSnapshot,
  segments: RecordUploadStatus["segments"] | null,
): EndGate {
  if (snapshot.state === "recording" || snapshot.state === "paused") {
    return { enabled: false, reason: "Stop the take first." };
  }
  if (snapshot.take_index < 0) {
    return { enabled: true };
  }
  if (
    segments === null ||
    segments.length === 0 ||
    segments.some((row) => !row.landed)
  ) {
    return {
      enabled: false,
      reason:
        "Wait for every take to reach the timeline before ending the session.",
    };
  }
  if ((snapshot.comments?.length ?? 0) > 0) {
    return {
      enabled: false,
      reason:
        "Wait for the live notes to reach the timeline before ending the session.",
    };
  }
  return { enabled: true };
}

type MoreRoomToneState = {
  state: RecordRoomState;
  noRecorder: boolean;
  roundLeftMs: number;
  hostCapturing: boolean;
};

/** Why the More sheet's Room tone cannot run now. A second round would restart every guest's capture. */
export function moreRoomToneReason(
  input: MoreRoomToneState,
): string | undefined {
  if (input.state === "recording" || input.state === "paused") {
    return TAKE_REASON;
  }
  if (input.noRecorder) {
    return "Room tone starts once someone has joined the room.";
  }
  if (input.roundLeftMs > 0) {
    return "Room tone is already recording.";
  }
  if (input.hostCapturing) {
    return "Your own room tone is recording.";
  }
  return undefined;
}

/** What is left of the guests' room-tone round. */
export function roomToneRoundLeftMs(
  snapshot: RecordSnapshot,
  elapsedSinceSnapshotMs: number,
): number {
  if (!snapshot.room_tone) {
    return 0;
  }
  return Math.max(
    0,
    (snapshot.countdown_left_ms ?? 0) - Math.max(0, elapsedSinceSnapshotMs),
  );
}
