import type { RoomAlertInput } from "../system/roomAlertModel";
import {
  type CaptureHealth,
  captureAttention,
  type RecordRoomState,
} from "./types";

export type RoomAlertSource = {
  state: RecordRoomState | undefined;
  captureHealth: CaptureHealth;
  keeperError: string | null;
  micLost: boolean;
  sinkError: string | null;
  uploadError: string | null;
  recoverable: boolean;
  monitorError: string | null;
  transportError: string | null;
  hydrateError: string | null;
  clipped: number;
  muted: boolean;
  micCheckFailed?: boolean;
};

export type RoomAlertActions = {
  retryMic?: () => void;
  checkMic?: () => void;
  retryStorage?: () => void;
  retryKeeper?: () => void;
  resumeUpload?: () => void;
  recover?: () => void;
  retryMonitor?: () => void;
  dismiss?: () => void;
};

export function roomAlerts(
  source: RoomAlertSource,
  actions: RoomAlertActions = {},
): RoomAlertInput[] {
  const { state } = source;
  const onAir = state === "recording" || state === "paused";
  const micLostShown = onAir && source.micLost;
  const { noAudio } = captureAttention(
    state,
    source.keeperError ? "failed" : source.captureHealth,
    micLostShown,
  );
  const alerts: RoomAlertInput[] = [];
  if (micLostShown) {
    alerts.push({ kind: "mic-lost", onAction: actions.retryMic });
  }
  if (noAudio) {
    alerts.push({
      kind: "no-audio",
      onAction: actions.checkMic,
      checkFailed: source.micCheckFailed,
    });
  }
  if (source.sinkError) {
    alerts.push({ kind: "storage-failed", onAction: actions.retryStorage });
  } else if (source.keeperError) {
    alerts.push({ kind: "storage-failed", onAction: actions.retryKeeper });
  }
  if (source.uploadError) {
    alerts.push({ kind: "saving-failed", onAction: actions.resumeUpload });
  }
  if (source.recoverable && actions.recover) {
    alerts.push({ kind: "recovery", onAction: actions.recover });
  }
  if (source.monitorError) {
    alerts.push({ kind: "monitor-failed", onAction: actions.retryMonitor });
  }
  if (source.clipped > 0 && state === "recording") {
    alerts.push({ kind: "clipping" });
  }
  if (source.muted && onAir) {
    alerts.push({ kind: "muted" });
  }
  const message = source.transportError ?? source.hydrateError;
  if (message) {
    alerts.push({ kind: "generic", message, onAction: actions.dismiss });
  }
  return alerts;
}
