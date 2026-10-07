import { plural } from "../utils/format";
import { MAX_CLIP_REGIONS } from "./keeper/clipRegions";
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

/** Why host Start is refused (server `start_blockers`); the panel words each one. */
export type StartBlocker =
  | { code: "no_guest" }
  | { code: "consent_pending"; participant_id: string; display_name: string };

export type RecordSnapshot = {
  session_id: string;
  state: RecordRoomState;
  take_index: number;
  recording_ms?: number;
  /** Derived current take origin; null outside recording/paused. */
  timeline_start_sec?: number | null;
  start_blockers?: StartBlocker[];
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
  "This session will be recorded in full quality on your device. After you Accept, your full-quality recording stays in this browser until it finishes saving to the host's project. Producers/listeners may be present and are shown in the roster.";

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

export const LOCAL_KEEPER_COPY = "Recording in full quality on this device.";
export const KEEPER_RECLAIM_MISMATCH_COPY =
  "This device's copy could not be checked against the file saved to the project, so it was kept. Download your full-quality recording before leaving.";
export const RECONNECT_MIC_COPY = "Reconnect microphone";
export const NO_AUDIO_COPY = "No audio is reaching the recorder.";
export const CHECK_MIC_COPY = "Check mic";
export const MIC_CHECK_FAILED_COPY =
  "Still no audio: unmute or reconnect your microphone, then Check mic again.";

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

export const ROOM_TONE_DURATION_SEC = 3;
export const ROOM_TONE_TOO_LOUD_DBFS = -35;
export const ROOM_TONE_PROMPT_COPY = "Record 3 seconds of room tone";
export const ROOM_TONE_TOO_LOUD_COPY = "Too loud: is something playing?";
export const ROOM_TONE_DONE_COPY = "Room tone saved";
export const ROOM_TONE_CAPTURING_COPY = "Recording room tone…";
/** Guest Accept requires record or skip. Host Start does not: idle is an implicit skip. */
export const ROOM_TONE_GATE_COPY = "Record or skip room tone before accepting.";
export const ROOM_TONE_NOT_READY_COPY = "Room tone capture is not ready yet.";

/** The capture problem a REC surface shows while recording. */
export type CaptureHealth = "pending" | "failed" | "silent" | null;

/** REC indicator label per capture problem. */
export const REC_CAPTURE_LABEL = {
  failed: "REC: local capture failed",
  pending: "REC: waiting for microphone",
  silent: "REC: no audio",
} as const satisfies Record<NonNullable<CaptureHealth>, string>;

/** Transport chip aria-label per capture problem while recording. */
export const REC_CHIP_CAPTURE_LABEL = {
  failed: "Local capture failed. Open record panel",
  pending: "Waiting for microphone. Open record panel",
  silent: "No audio reaching the recorder. Open record panel",
} as const satisfies Record<NonNullable<CaptureHealth>, string>;

/** Appended to the REC label while the host record socket is down. */
export const REC_OFFLINE_SUFFIX = "(reconnecting)";

/** Transport chip aria-label while the host record socket is down mid-take. */
export const REC_CHIP_OFFLINE_LABEL =
  "Record room reconnecting. Open record panel";

/** Record panel notice while the host record socket is down mid-take. */
export const RECORD_ROOM_RECONNECTING_COPY =
  "Lost connection to the record room. Reconnecting…";

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

/**
 * What a REC surface shows for a resolved capture problem: the label to use
 * and whether the no-audio notice is due. `suppressSilent` drops a silent
 * result (for example while mic loss is already shown), so Room and
 * RecordPanel gate the no-audio alert the same way.
 */
export function captureAttention(
  state: RecordRoomState | undefined,
  health: CaptureHealth,
  suppressSilent = false,
): { capture: CaptureHealth; noAudio: boolean } {
  const capture = health === "silent" && suppressSilent ? null : health;
  return { capture, noAudio: state === "recording" && capture === "silent" };
}

export const HEADROOM_HINT_COPY =
  "Peaks should stay in the green. Record with headroom: you can always turn it up later, you cannot unclip.";
export const METER_CLIPPED_COPY =
  "Your mic clipped. Move back or lower your input gain.";

export const NO_CLIPPING_COPY = "No clipping detected on your mic.";
export const CLIPPING_RECOVERY_COPY =
  "Clipping cannot be undone in the recording. Lower your input gain and re-record any section that matters.";
export const CLIPPING_TRUNCATED_COPY = `Only the first ${MAX_CLIP_REGIONS} clipped spans of each recording segment are listed. Your mic clipped again after that.`;
export const CLIPPING_JUNCTION_HINT =
  "Available after the take lands on the timeline";

/** Live notice while a take is recording and the encoder has seen clipping. */
export function clippingLiveCopy(count: number): string {
  return count === 1
    ? "Your mic clipped during this take. Move back or lower your input gain."
    : `Your mic has clipped ${count} times during this take. Move back or lower your input gain.`;
}

/** Post-take summary line. */
export function clippingReportCopy(count: number, take: number): string {
  const places = count === 1 ? "1 place" : `${count} places`;
  return `Your mic clipped in ${places} in take ${take + 1}.`;
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
