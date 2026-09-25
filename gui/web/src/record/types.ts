import { plural } from "../utils/format";
import type { LiveComment } from "./liveCommentQueue";

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
 * One upload segment's ack state as the host roster reads it. Transport
 * status rows (`RecordUploadStatus.segments`) extend this with take/segment
 * indices.
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
  /** Server-owned per-take consent roster (gates keeper uploads); null = legacy take. Read this, do not re-derive from live `consented`. */
  consented_participant_ids?: string[] | null;
};

export type RecordSnapshot = {
  session_id: string;
  state: RecordRoomState;
  take_index: number;
  recording_ms?: number;
  start_blockers?: string[];
  participants: RecordParticipant[];
  caps: { recorded: number; producers: number };
  server_time_ns?: number;
  comments?: LiveComment[];
  takes?: TakeState[];
  pause_reason?: PauseReason | null;
  host_offline_since_wall_ms?: number | null;
  host_offline_gap_ms?: number | null;
};

export const CONSENT_COPY =
  "This session will be recorded locally on your device. Files stay on this browser until they finish uploading to the host after you Accept. Producers/listeners may be present and are shown in the roster.";

export const FULL_ROOM_COPY = "This room is full (4 recorded / 2 producers).";

export const DECLINED_COPY =
  "You declined recording. You can wait in the lobby, or the host can invite you as a producer (listen only).";

export const SPEAKERS_WARNING =
  "Use headphones. Playing the room on speakers will echo into every mic.";

export const HOST_OFFLINE_COPY = "Host offline: still recording locally.";

export function hostReconnectPauseCopy(offlineGapMs: number): string {
  const seconds = Math.max(0, Math.round(offlineGapMs / 1000));
  return `Paused: the host was offline for ${seconds}s. Resume when everyone is ready.`;
}

export function hostReconnectPauseCopyFromSnapshot(
  snapshot: RecordSnapshot,
): string | null {
  if (snapshot.state !== "paused" || snapshot.host_offline_gap_ms == null) {
    return null;
  }
  const take = snapshot.takes?.find(
    (row) => row.take_index === snapshot.take_index,
  );
  const last = take?.pauses.at(-1);
  if (last != null && last.resume_wall_ms != null) {
    return null;
  }
  const reason = snapshot.pause_reason ?? last?.pause_reason ?? null;
  if (reason !== "host_reconnect") {
    return null;
  }
  return hostReconnectPauseCopy(snapshot.host_offline_gap_ms);
}

export function hostKeeperResetKey(snapshot: RecordSnapshot | null): number {
  if (snapshot?.pause_reason !== "host_reconnect") {
    return 0;
  }
  const take = snapshot.takes?.find(
    (row) => row.take_index === snapshot.take_index,
  );
  const open = take?.pauses.find(
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

export const LOCAL_KEEPER_COPY = "Recording locally on this device.";
export const KEEPER_RECLAIM_MISMATCH_COPY =
  "This local keeper could not be verified against the landed file, so its WAV was retained. Download the local keeper before leaving.";
export const RECONNECT_MIC_COPY = "Reconnect microphone";
export const NO_AUDIO_COPY = "No audio is reaching the recorder.";
export const CHECK_MIC_COPY = "Check mic";
export const MIC_CHECK_FAILED_COPY =
  "Still no audio: unmute or reconnect your microphone, then Check mic again.";

export const HEARING_COPY = "Hearing the room.";

export const UPLOAD_COPY = "Uploading your take… Keep this tab open.";

export function uploadProgressCopy(acked: number, total: number): string {
  if (total <= 0) {
    return UPLOAD_COPY;
  }
  return `Uploading your take… ${acked}/${total} chunks. Keep this tab open.`;
}

export const UPLOAD_DONE_COPY =
  "Landed on the host. The local backup is cleared automatically.";
export const UPLOAD_STALLED_COPY =
  "Upload stalled. Resume the upload or download the local keeper copy.";
export const KEEPER_ALL_RECLAIMED_COPY =
  "Every recorded segment landed on the host and its local copy was cleared, so there is nothing left to download.";
export const KEEPER_RECLAIM_FAILED_COPY =
  "Landed on the host, but this browser could not clear the local backup. Free device storage manually before recording again.";
export const STORAGE_UNKNOWN_COPY =
  "Storage availability could not be checked. Check your device's free space before recording; if upload fails, download the local keeper.";
export function storageLowCopy(minutes: number): string {
  return `Local recording storage is low (estimated space for about ${minutes} minutes of audio). Free space before recording; if upload fails, download the local keeper.`;
}
export const UPLOAD_WAITING_TO_LAND_COPY =
  "Uploaded; waiting to land on the host. Keep the local backup.";
export const UPLOAD_LAND_FAILED_COPY =
  "Uploaded but not landed on the host. Keep the local backup; ask the host to retry landing.";
export const UPLOAD_SINK_ERROR_COPY =
  "Local recording backup is unavailable. Check that this browser or app environment allows local storage, then retry.";
export const OPFS_UNAVAILABLE_COPY =
  "Local recording backup is unavailable because this browser or app environment does not support OPFS. Use a compatible browser, then retry.";
export const LOCAL_KEEPER_PENDING_COPY = "Preparing local recording backup…";
export const UPLOAD_STATUS_ID = "record-upload-status";

export const ROOM_TONE_DURATION_SEC = 3;
export const ROOM_TONE_TOO_LOUD_DBFS = -35;
export const ROOM_TONE_PROMPT_COPY = "Record 3 seconds of room tone";
export const ROOM_TONE_TOO_LOUD_COPY = "Too loud: is something playing?";
export const ROOM_TONE_DONE_COPY = "Room tone saved";
export const ROOM_TONE_CAPTURING_COPY = "Recording room tone…";
/** Guest Accept requires record or skip. Host Start does not: idle is an implicit skip. */
export const ROOM_TONE_GATE_COPY = "Record or skip room tone before accepting.";
export const ROOM_TONE_NOT_READY_COPY = "Room tone capture is not ready yet.";

export function hostUploadLine(
  name: string,
  fileAck: boolean,
  ackedParts: number,
  expectedParts: number | null = null,
  landed = false,
  landFailed = false,
): string {
  if (landFailed) {
    return `${name}: landing failed. The host must retry.`;
  }
  if (landed) {
    return `${name}: landed.`;
  }
  if (fileAck) {
    return `${name}: uploaded; waiting to land.`;
  }
  if (expectedParts != null) {
    return `${name}: ${ackedParts}/${expectedParts} ${plural(expectedParts, "chunk")} acked.`;
  }
  if (ackedParts <= 0) {
    return `${name}: waiting to upload.`;
  }
  return `${name}: ${ackedParts} ${plural(ackedParts, "chunk")} acked.`;
}

/** The capture problem a REC surface shows while recording. */
export type CaptureHealth = "pending" | "failed" | "silent" | null;

/**
 * Resolves the capture problem a REC surface shows while recording. A keeper
 * error outranks everything and mic trouble outranks no audio, so the REC
 * label and the notice beneath it never disagree.
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
