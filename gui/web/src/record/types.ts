import { plural } from "../utils/format";
import type { LiveComment } from "./liveCommentQueue";
import { SAVE_STATE_COPY } from "./saveStatus";

export type { LiveComment } from "./liveCommentQueue";

export type RecordRole = "host" | "guest" | "producer";
export type RecordRoomState = "lobby" | "recording" | "paused" | "stopped";
export type PauseReason = "host_reconnect";

export type RecordParticipant = {
  participant_id: string;
  role: RecordRole;
  display_name: string;
  connected: boolean;
  consented: boolean | null;
  muted: boolean;
  headphones_ack: boolean;
  removed?: boolean;
  joined_wall_ms?: number;
  connected_wall_ms?: number | null;
};

/**
 * One upload segment's ack state as the host's status list reads it. Transport
 * status rows (`RecordUploadStatus.segments`, `SegmentAckRow`) extend this with
 * take/segment indices.
 */
export type RecordSegmentAck = {
  participant_id: string;
  acked_parts: number[];
  file_ack?: boolean;
  expected_parts?: number | null;
  landed?: boolean;
  land_failed?: boolean;
  file_sha256?: string | null;
  byte_length?: number | null;
  join_offset_ms?: number;
  /** Segment-relative `[startMs, endMs]` spans the upload carried; null when none were sent. */
  clipping_regions?: [number, number][] | null;
  clipping_truncated?: boolean;
};

export type PauseEntry = {
  seq: number;
  pause_wall_ms: number;
  resume_wall_ms: number | null;
  pause_reason?: PauseReason | null;
};

export type TakeState = {
  take_index: number;
  session_start_wall_ms: number;
  session_start_iso: string;
  stopped_wall_ms?: number | null;
  pauses: PauseEntry[];
  /** Server-owned roster for keeper uploads, independent of live consent. */
  consented_participant_ids: string[];
  /** Segment counts each participant reported for this take, by participant id. */
  segment_reports?: Record<string, number>;
};

export type SessionTarget =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "insert"; at_sec: number }
  | {
      kind: "replace";
      from_sec: number;
      to_sec: number;
      track_ids: string[];
    };

export type RoomToneRound = {
  round: number;
  requested_wall_ms: number;
  duration_ms: number;
  participant_ids: string[];
};

/** Why host Start is refused (server `start_blockers`); the panel words each one. */
export type StartBlocker =
  | { code: "no_recorder" }
  | { code: "consent_pending"; participant_id: string; display_name: string };

export type RecordSnapshot = {
  session_id: string;
  state: RecordRoomState;
  take_index: number;
  recording_ms?: number;
  /** Derived current take origin; null outside recording/paused. */
  timeline_start_sec?: number | null;
  start_blockers?: StartBlocker[];
  room_tone?: RoomToneRound | null;
  /** Host only: where this session lands; the server strips it from guest snapshots. */
  target?: SessionTarget;
  /** Ms left of the current room-tone round at snapshot time; count down locally from it. */
  countdown_left_ms?: number;
  participants: RecordParticipant[];
  caps: { recorded: number; producers: number };
  server_time_ns?: number;
  comments?: LiveComment[];
  takes?: TakeState[];
  pause_reason?: PauseReason | null;
  host_offline_since_wall_ms?: number | null;
  host_offline_gap_ms?: number | null;
};

/** One row of the host's record-session read model (`GET /api/record/sessions`), open or ended. */
export type RecordSessionSummary = {
  session_id: string;
  /** Null until the session has landed on the timeline. */
  number: number | null;
  /** The host's name for the session; null shows the default heading. */
  name: string | null;
  state: "open" | "ended";
  target_kind: SessionTarget["kind"] | null;
  takes: { take_index: number; recording_ms: number }[];
  participants: {
    participant_id: string;
    display_name: string;
    role: RecordRole;
    track_id: string | null;
  }[];
  landed: boolean;
  ended_at: string | null;
};

export function hostReconnectPauseCopy(offlineGapMs: number): string {
  const seconds = Math.max(0, Math.round(offlineGapMs / 1000));
  return `Paused: the host was offline for ${seconds}s. Resume when everyone is ready.`;
}

/** The take whose `take_index` matches `snapshot.take_index`, if any (no fallback). */
export function findCurrentTake<T extends { take_index: number }>(snapshot: {
  take_index: number;
  takes?: readonly T[];
}): T | undefined {
  return snapshot.takes?.find((row) => row.take_index === snapshot.take_index);
}

export function hostReconnectPauseCopyFromSnapshot(
  snapshot: RecordSnapshot,
): string | null {
  if (snapshot.state !== "paused" || snapshot.host_offline_gap_ms == null) {
    return null;
  }
  const last = findCurrentTake(snapshot)?.pauses.at(-1);
  if (last != null && last.resume_wall_ms != null) {
    return null;
  }
  const reason = snapshot.pause_reason ?? last?.pause_reason ?? null;
  if (reason !== "host_reconnect") {
    return null;
  }
  return hostReconnectPauseCopy(snapshot.host_offline_gap_ms);
}

export function isRecordTransportVisible(
  snapshot: RecordSnapshot | null,
): snapshot is RecordSnapshot {
  return snapshot !== null && snapshot.state !== "lobby";
}

export function hostKeeperResetKey(snapshot: RecordSnapshot | null): number {
  if (snapshot?.pause_reason !== "host_reconnect") {
    return 0;
  }
  const open = findCurrentTake(snapshot)?.pauses.find(
    (row) =>
      row.pause_reason === "host_reconnect" && row.resume_wall_ms == null,
  );
  return (open?.seq ?? 0) + 1;
}

export function shouldApplyRecordSnapshot(
  incoming: RecordSnapshot,
  current: RecordSnapshot | null,
): boolean {
  if (!current) {
    return true;
  }
  const currentNs = current.server_time_ns;
  if (currentNs == null) {
    return true;
  }
  const incomingNs = incoming.server_time_ns;
  return incomingNs != null && incomingNs >= currentNs;
}

/** Server clamp on a reported segment count (`MAX_REPORTED_SEGMENTS`). */
export const MAX_REPORTED_SEGMENTS = 5000;

export const END_SESSION_UNDO_MS = 10_000;
export const END_SESSION_PENDING_COPY = `Ending this session in ${END_SESSION_UNDO_MS / 1000} seconds. Guest links stop working when it ends.`;
export const LOCAL_KEEPER_COPY = "Recording in full quality on this device.";
export const KEEPER_RECLAIM_MISMATCH_COPY =
  "This device's copy could not be checked against the file saved to the project, so it was kept. Download your full-quality recording before leaving.";

export const HEARING_COPY = "Hearing the room.";

export const UPLOAD_COPY = `${SAVE_STATE_COPY.saving} Keep this tab open.`;

export function uploadProgressCopy(acked: number, total: number): string {
  if (total <= 0) {
    return UPLOAD_COPY;
  }
  return `${SAVE_STATE_COPY.saving} ${acked} of ${total} ${plural(total, "chunk")}. Keep this tab open.`;
}

export const UPLOAD_DONE_COPY =
  "Saved to project and on the timeline. This device's copy clears automatically.";
export const UPLOAD_STALLED_COPY =
  "Saving stalled. Resume saving, or download your full-quality recording.";
export const KEEPER_ALL_RECLAIMED_COPY =
  "Every segment of your full-quality recording is saved to the project and cleared from this device, so there is nothing left to download.";
export const KEEPER_RECLAIM_FAILED_COPY =
  "Saved to project, but this browser could not clear this device's copy. Free device storage manually before recording again.";
export const STORAGE_UNKNOWN_COPY =
  "Storage availability could not be checked. Check your device's free space before recording; if saving to the project fails, download your full-quality recording.";
export function storageLowCopy(minutes: number): string {
  return `Device storage is low (room for about ${minutes} minutes of full-quality recording). Free space before recording; if saving to the project fails, download your full-quality recording.`;
}
export const UPLOAD_WAITING_TO_LAND_COPY =
  "Saved to project. This device keeps its copy until the host lands it on the timeline.";
export const UPLOAD_LAND_FAILED_COPY =
  "Saved to project, but not on the timeline yet. This device keeps its copy; ask the host to Retry land.";
export const UPLOAD_SINK_ERROR_COPY =
  "This device can't store your full-quality recording. Check that this browser or app allows local storage, then retry.";
export const OPFS_UNAVAILABLE_COPY =
  "This device can't store your full-quality recording because this browser or app does not support private file storage. Use a compatible browser, then retry.";
export const LOCAL_KEEPER_PENDING_COPY =
  "Preparing device storage for your full-quality recording…";
export const UPLOAD_STATUS_ID = "record-upload-status";

/** One minute of quiet; the server's `ROOM_TONE_DURATION_SEC` must match. */
export const ROOM_TONE_DURATION_SEC = 60;
/** End early keeps a take at least this long; a shorter one is discarded. */
export const ROOM_TONE_MIN_SEC = 10;
export const ROOM_TONE_TOO_LOUD_DBFS = -35;
export const ROOM_TONE_PROMPT_COPY = "Record 1 minute of room tone";
export const ROOM_TONE_TOO_SHORT_COPY = `Too short, record at least ${ROOM_TONE_MIN_SEC} seconds`;
export const ROOM_TONE_TOO_LOUD_COPY = "Too loud: is something playing?";
export const ROOM_TONE_DEVICE_COPY = "Room tone saved on this device";
export const ROOM_TONE_HOST_COPY = "Room tone sent to the host";
export const ROOM_TONE_CAPTURING_COPY = "Recording room tone…";
export const ROOM_TONE_SAVING_COPY = "Saving room tone…";
export const ROOM_TONE_NOT_READY_COPY = "Room tone capture is not ready yet.";

/** The capture problem a REC surface shows while recording. */
export type CaptureHealth = "pending" | "failed" | "silent" | null;

/** Record stage notice while the host record socket is down mid-take. */
export const RECORD_ROOM_RECONNECTING_COPY =
  "Lost connection to the record room. Reconnecting…";

/**
 * Resolves the capture problem a record surface shows while recording. A
 * keeper error outranks everything and mic trouble outranks no audio, so the
 * alerts never disagree.
 */
export function resolveCaptureHealth(
  keeperError: boolean,
  micHealth: "pending" | "failed" | null,
  silent: boolean,
): CaptureHealth {
  if (keeperError) return "failed";
  if (micHealth) return micHealth;
  return silent ? "silent" : null;
}

/**
 * What a REC surface shows for a resolved capture problem: the label to use
 * and whether the no-audio notice is due. `suppressSilent` drops a silent
 * result (for example while mic loss is already shown), so the guest room and
 * the Record stage gate the no-audio alert the same way.
 */
export function captureAttention(
  state: RecordRoomState | undefined,
  health: CaptureHealth,
  suppressSilent = false,
): { capture: CaptureHealth; noAudio: boolean } {
  const capture = health === "silent" && suppressSilent ? null : health;
  return { capture, noAudio: state === "recording" && capture === "silent" };
}

/** Mirrors Python `record_source_id`: the source id a landed keeper gets. */
export function recordSourceId(
  sessionId: string,
  takeIndex: number,
  participantId: string,
  segmentIndex: number,
): string {
  return `rec-${sessionId}-${takeIndex}-${participantId}-${segmentIndex}`;
}
