import { useCallback, useEffect, useRef } from "react";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { prepareHostKeeperStorage } from "./hostKeeperStorage";
import { useRecordHostStore } from "./hostStore";
import { sendRecordHostCommand } from "./hostWire";
import type { TakeClipping } from "./keeper/clipRegions";
import { useKeeperCapture } from "./keeper/useKeeperCapture";
import { type MicPermissionStatus, statusFromGumError } from "./micPermission";
import { hostKeeperResetKey, type RecordSnapshot } from "./types";
import { keeperCaptureSettled } from "./upload/useRecordUpload";
import { useMicStream } from "./useMicStream";
import { useTakeClipping } from "./useTakeClipping";

export function useHostKeeperCapture(enabled = true): {
  error: string | null;
  micError: string | null;
  micPending: boolean;
  micStatus: MicPermissionStatus | null;
  recordingLocally: boolean;
  retry: () => void;
  finalizing: boolean;
  stream: MediaStream | null;
  muted: boolean;
  monitorEnabled: boolean;
  snapshot: RecordSnapshot | null;
  micLost: boolean;
  retryMic: () => void;
  noAudio: boolean;
  micCheckFailed: boolean;
  checkMic: () => void;
  clipping: TakeClipping | null;
} {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const connected = useRecordHostStore((s) => s.connected);
  const sink = useRecordHostStore((s) => s.keeperSink);
  const setCaptureHealth = useRecordHostStore((s) => s.setCaptureHealth);
  const pathRef = useRef(projectPath);

  useEffect(() => {
    if (pathRef.current !== projectPath) {
      pathRef.current = projectPath;
      setSnapshot(null);
    }
  }, [projectPath, setSnapshot]);

  const share = isShareProjectKey(projectPath);
  const hostOn = enabled && !share;
  const keeperLive =
    snapshot?.state === "recording" || snapshot?.state === "paused";
  const micLive = hostOn && !!snapshot;
  const host = snapshot?.participants.find(
    (person) => person.participant_id === "p_host",
  );
  const sessionId = snapshot?.session_id ?? null;
  const roomState = snapshot?.state ?? null;
  const resetKey = hostKeeperResetKey(snapshot);
  const lastActivityBeatRef = useRef<number | null>(null);
  const onKeeperActivity = useCallback(() => {
    const now = performance.now();
    if (
      lastActivityBeatRef.current !== null &&
      now - lastActivityBeatRef.current < 5_000
    ) {
      return;
    }
    if (sendRecordHostCommand("Heartbeat")) {
      lastActivityBeatRef.current = now;
    }
  }, []);

  useEffect(() => {
    if (hostOn && keeperLive && !sink) {
      void prepareHostKeeperStorage().catch(() => undefined);
    }
  }, [hostOn, keeperLive, sink]);

  const mic = useMicStream(micLive, "", resetKey);
  const keeper = useKeeperCapture({
    enabled: hostOn && keeperLive && sink !== null,
    role: "host",
    snapshot,
    participantId: hostOn && keeperLive ? "p_host" : null,
    muted: host?.muted ?? false,
    consented: true,
    stream: mic.stream,
    sink,
    resetKey,
    onActivity: onKeeperActivity,
  });
  const clipping = useTakeClipping({
    sink,
    sessionId,
    participantId: hostOn ? "p_host" : null,
    takeIndex: snapshot?.take_index ?? -1,
    roomState: snapshot?.state,
    captureSettled: keeperCaptureSettled(keeper),
    live: keeper.clipping,
  });
  const setTakeClipping = useRecordHostStore((s) => s.setTakeClipping);
  useEffect(() => {
    setTakeClipping(clipping);
    return () => setTakeClipping(null);
  }, [clipping, setTakeClipping]);
  useEffect(() => {
    if (
      !hostOn ||
      !sessionId ||
      keeper.recordingLocally ||
      (roomState !== "lobby" && roomState !== "paused")
    ) {
      return;
    }
    const timer = window.setInterval(onKeeperActivity, 5_000);
    return () => window.clearInterval(timer);
  }, [hostOn, sessionId, roomState, keeper.recordingLocally, onKeeperActivity]);

  let micStatus: MicPermissionStatus | null = null;
  if (hostOn && snapshot) {
    if (mic.error) {
      micStatus = mic.errorName
        ? (statusFromGumError(mic.errorName) ?? "error")
        : "error";
    } else if (mic.pending || (!mic.lost && !mic.stream)) {
      micStatus = "prompting";
    } else if (mic.stream) {
      micStatus = "granted";
    }
  }

  useEffect(() => {
    const health =
      roomState !== "recording" || !hostOn
        ? null
        : keeper.error || (!mic.pending && !mic.stream)
          ? "failed"
          : !mic.stream
            ? "pending"
            : keeper.noAudio
              ? "silent"
              : null;
    setCaptureHealth(health);
    return () => setCaptureHealth(null);
  }, [
    hostOn,
    keeper.error,
    keeper.noAudio,
    mic.pending,
    mic.stream,
    roomState,
    setCaptureHealth,
  ]);

  return {
    error: keeper.error,
    micError: mic.error,
    micPending: Boolean(mic.pending),
    micStatus,
    recordingLocally: keeper.recordingLocally,
    retry: keeper.retry,
    finalizing: keeper.finalizing,
    stream: mic.stream,
    muted: host?.muted ?? false,
    monitorEnabled: hostOn && !!snapshot && connected,
    snapshot,
    micLost: mic.lost,
    retryMic: mic.retry,
    noAudio: keeper.noAudio,
    micCheckFailed: keeper.micCheckFailed,
    checkMic: keeper.checkMic,
    clipping,
  };
}
