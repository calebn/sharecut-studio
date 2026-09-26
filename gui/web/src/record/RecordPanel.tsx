import { useEffect, useId, useMemo, useRef, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { execute } from "../commands/execute";
import { useDaw } from "../state/useDaw";
import { Button, Dialog } from "../ui";
import { errorMessage } from "../utils/apiError";
import { startBlockers } from "./blockers";
import { HostUploadRoster } from "./HostUploadRoster";
import {
  prepareHostKeeperStorage,
  retryHostKeeperStorage,
} from "./hostKeeperStorage";
import { useRecordHostStore } from "./hostStore";
import { sendRecordHostCommand } from "./hostWire";
import { LiveComments } from "./LiveComments";
import { HOST_COMMENT_QUEUE_TOKEN } from "./liveCommentQueue";
import { MicLossNotice } from "./MicLossNotice";
import {
  copyForMicStatus,
  MIC_RETRY_LABEL,
  type MicPermissionStatus,
  micGrantFailed,
} from "./micPermission";
import { NoAudioNotice } from "./NoAudioNotice";
import { RecIndicator } from "./RecIndicator";
import { RoomToneCapture } from "./RoomToneCapture";
import { Roster } from "./Roster";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import {
  captureAttention,
  HEARING_COPY,
  hostReconnectPauseCopyFromSnapshot,
  LOCAL_KEEPER_COPY,
  LOCAL_KEEPER_PENDING_COPY,
  RECORD_ROOM_RECONNECTING_COPY,
  shouldApplyRecordSnapshot,
} from "./types";
import { UploadStatus } from "./UploadStatus";
import { useKeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import {
  keeperCaptureSettled,
  leaveBlocked,
  useHostUploadSegments,
  useRecordUpload,
} from "./upload/useRecordUpload";
import { useRecordLiveComments } from "./useRecordLiveComments";
import { useRoomToneCapture } from "./useRoomToneCapture";

type Props = {
  recordingLocally?: boolean;
  keeperFinalizing?: boolean;
  keeperError?: string | null;
  onRetryKeeper?: () => void;
  micError?: string | null;
  micPending?: boolean;
  micStatus?: MicPermissionStatus | null;
  hearing?: boolean;
  monitorError?: string | null;
  stream?: MediaStream | null;
  micLost?: boolean;
  onRetryMic?: () => void;
  onCheckMic?: () => void;
  micCheckFailed?: boolean;
};

export function RecordPanel({
  recordingLocally = false,
  keeperFinalizing = false,
  keeperError = null,
  onRetryKeeper,
  micError = null,
  micPending = false,
  micStatus = null,
  hearing = false,
  monitorError = null,
  stream = null,
  micLost = false,
  onRetryMic,
  onCheckMic,
  micCheckFailed = false,
}: Props) {
  const micHintId = useId();
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    shareDialogOpen,
    projectPath,
    setShareDialogOpen,
  } = useDaw((s) => ({
    recordPanelOpen: s.recordPanelOpen,
    setRecordPanelOpen: s.setRecordPanelOpen,
    shareDialogOpen: s.shareDialogOpen,
    projectPath: s.projectPath,
    setShareDialogOpen: s.setShareDialogOpen,
  }));
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const blockers = startBlockers(snapshot);
  const state = snapshot?.state;
  const recording = state === "recording";
  const paused = state === "paused";
  // No audio is a soft warning: it opens the dialog once but never pins it.
  const captureUnavailable =
    recording && (captureHealth === "pending" || captureHealth === "failed");
  const micLossNeedsAttention = (recording || paused) && micLost;
  // captureHealth is already merged by useHostKeeperCapture; a keeper error
  // prop still outranks it, and shown mic loss suppresses no audio.
  const { capture, noAudio: noAudioNeedsAttention } = captureAttention(
    state,
    keeperError ? "failed" : captureHealth,
    micLossNeedsAttention,
  );
  useEffect(() => {
    if (
      (micLossNeedsAttention || captureUnavailable) &&
      !recordPanelOpen &&
      !shareDialogOpen
    ) {
      setRecordPanelOpen(true);
    }
  }, [
    captureUnavailable,
    micLossNeedsAttention,
    recordPanelOpen,
    setRecordPanelOpen,
    shareDialogOpen,
  ]);
  const noAudioShown = useRef(false);
  useEffect(() => {
    if (noAudioNeedsAttention && !noAudioShown.current && !shareDialogOpen) {
      setRecordPanelOpen(true);
    }
    noAudioShown.current = noAudioNeedsAttention;
  }, [noAudioNeedsAttention, setRecordPanelOpen, shareDialogOpen]);
  const host = snapshot?.participants.find(
    (person) => person.participant_id === "p_host",
  );
  // Raw socket state on purpose: live comments send now or queue for upsert on
  // reconnect, including before the first connect. `dropped` (below) is only for
  // the "Reconnecting…" copy, which must not show before the first connect.
  const connected = useRecordHostStore((s) => s.connected);
  const liveComments = useRecordLiveComments({
    token: HOST_COMMENT_QUEUE_TOKEN,
    snapshot,
    me: host ?? null,
    connected,
    send: (commandType, payload, commandId) =>
      sendRecordHostCommand(commandType, payload, commandId),
  });
  const transportError = useRecordHostStore((s) => s.transportError);
  const setTransportError = useRecordHostStore((s) => s.setTransportError);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [transportBusy, setTransportBusy] = useState(false);
  const sink = useRecordHostStore((s) => s.keeperSink);
  const sinkError = useRecordHostStore((s) => s.keeperStorageError);
  const [uploadRetryNonce, setUploadRetryNonce] = useState(0);
  useEffect(() => {
    void prepareHostKeeperStorage().catch(() => undefined);
  }, []);
  const localStorageReady = sink !== null;
  const canStart =
    blockers.length === 0 &&
    (state === "lobby" || state === "stopped") &&
    localStorageReady;
  const uploadTransport = useMemo(
    () => (projectPath ? hostRecordUploadTransport(projectPath) : null),
    [projectPath],
  );
  const captureSettled = keeperCaptureSettled({
    recordingLocally,
    finalizing: keeperFinalizing,
    error: keeperError ?? null,
  });
  const upload = useRecordUpload({
    enabled: !!snapshot,
    roomState: snapshot?.state,
    captureSettled,
    sessionId: snapshot?.session_id ?? null,
    takeIndex: snapshot?.take_index ?? 0,
    participantId: "p_host",
    transport: uploadTransport,
    sink,
    captureExpected: (snapshot?.take_index ?? -1) >= 0 && host != null,
    retryNonce: uploadRetryNonce,
  });
  const keeperActions = useKeeperRecoveryActions({
    sink,
    sessionId: snapshot?.session_id ?? null,
    participantId: "p_host",
    takeIndex: snapshot?.take_index ?? null,
    recoverAllowed: state === "stopped" && captureSettled,
    onRecovered: () => setUploadRetryNonce((value) => value + 1),
  });
  const roomToneEnabled =
    !!snapshot && (snapshot.state === "lobby" || snapshot.state === "stopped");
  const roomTone = useRoomToneCapture({
    enabled: roomToneEnabled,
    canUpload: roomToneEnabled,
    stream,
    sessionId: snapshot?.session_id ?? null,
    participantId: "p_host",
    sink,
    transport: uploadTransport,
  });
  const capturingRoomTone = roomTone.status === "capturing";
  const hostSegments = useHostUploadSegments(uploadTransport, !!snapshot);
  const landFailed = hostSegments.some((row) => row.land_failed);

  // Same path as the keyboard and palette for all five buttons: record.* owns clearing, storing and announcing errors; transportBusy blocks double sends.
  const runTransport = (commandId: string) => {
    setTransportBusy(true);
    void execute(commandId, {}, { skipWhen: true }).finally(() => {
      setTransportBusy(false);
    });
  };

  // Single owner for clearing: a stored command failure lives only while this panel shows it.
  useEffect(() => {
    if (!recordPanelOpen) {
      setTransportError(null);
    }
  }, [recordPanelOpen, setTransportError]);
  useEffect(
    () => () => {
      setTransportError(null);
    },
    [projectPath, setTransportError],
  );

  useEffect(() => {
    if (!recordPanelOpen || !projectPath) {
      return;
    }
    let cancelled = false;
    setHydrateError(null);
    void loadHostRecordState(projectPath)
      .then((snap) => {
        if (cancelled || !snap) {
          return;
        }
        const current = useRecordHostStore.getState().snapshot;
        if (shouldApplyRecordSnapshot(snap, current)) {
          setSnapshot(snap);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHydrateError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [recordPanelOpen, projectPath, setSnapshot]);

  const dropped = useRecordHostStore((s) => s.dropped);
  const offline =
    dropped &&
    (snapshot?.state === "recording" || snapshot?.state === "paused");
  const uploadBlocking = leaveBlocked(state ?? "", upload);
  const reconnectCopy = snapshot
    ? hostReconnectPauseCopyFromSnapshot(snapshot)
    : null;
  const micCopy =
    micStatus && micStatus !== "lost" ? copyForMicStatus(micStatus) : null;
  const micFailed =
    micStatus && micStatus !== "lost" ? micGrantFailed(micStatus) : false;

  return (
    <Dialog
      open={recordPanelOpen}
      onClose={() => setRecordPanelOpen(false)}
      title="Record room"
      closeDisabled={
        uploadBlocking || micLossNeedsAttention || captureUnavailable
      }
    >
      <div className="stack record-panel">
        {snapshot ? (
          <RecIndicator
            snapshot={snapshot}
            capture={capture}
            offline={offline}
          />
        ) : null}
        {offline ? (
          <p className="record-warn" role="status">
            {RECORD_ROOM_RECONNECTING_COPY}
          </p>
        ) : null}
        <StorageHeadroomWarning
          visible={state === "lobby" || state === "stopped"}
          recheck={state === "stopped"}
        />
        {snapshot &&
        (snapshot.state === "lobby" || snapshot.state === "stopped") ? (
          <RoomToneCapture
            status={roomTone.status}
            error={roomTone.error}
            micReady={!!stream}
            captureReady={localStorageReady && roomTone.captureReady}
            onRecord={roomTone.record}
            onSkip={roomTone.skip}
            onRetry={roomTone.retry}
          />
        ) : null}
        <div aria-live="polite">
          {reconnectCopy ? (
            <p className="record-warn">{reconnectCopy}</p>
          ) : null}
          {recordingLocally && !keeperError && !noAudioNeedsAttention ? (
            <p>{LOCAL_KEEPER_COPY}</p>
          ) : null}
          {micLossNeedsAttention ? (
            <MicLossNotice onRetry={onRetryMic} />
          ) : null}
          {noAudioNeedsAttention ? (
            <NoAudioNotice onCheck={onCheckMic} checkFailed={micCheckFailed} />
          ) : null}
          {hearing ? <p>{HEARING_COPY}</p> : null}
          {micCopy ? (
            <p
              id={micHintId}
              role={micPending ? "status" : undefined}
              className={micFailed ? "record-warn" : undefined}
            >
              {micCopy}
            </p>
          ) : null}
          {micError && micStatus === "error" ? (
            <p className="record-warn">{micError}</p>
          ) : null}
          {micFailed && onRetryMic && !micLost ? (
            <Button
              type="button"
              onClick={onRetryMic}
              aria-describedby={micHintId}
            >
              {MIC_RETRY_LABEL}
            </Button>
          ) : null}
          <UploadStatus
            progress={upload}
            stopped={state === "stopped"}
            onResume={() => setUploadRetryNonce((value) => value + 1)}
            actions={keeperActions}
          />
          {snapshot ? (
            <HostUploadRoster
              participants={snapshot.participants}
              segments={hostSegments}
              stopped={state === "stopped"}
            />
          ) : null}
          {keeperError ? (
            <>
              <p className="record-warn">
                Local recording stopped: {keeperError}
              </p>
              {onRetryKeeper ? (
                <Button
                  type="button"
                  onClick={onRetryKeeper}
                  disabled={!recording}
                >
                  Retry local recording
                </Button>
              ) : null}
              {!recording ? (
                <p>
                  {paused
                    ? "Resume the take before retrying local recording."
                    : "Start a new take before retrying local recording."}
                </p>
              ) : null}
            </>
          ) : null}
          {sinkError ? (
            <>
              <p className="record-warn">{sinkError}</p>
              <Button
                type="button"
                onClick={() => {
                  void retryHostKeeperStorage().catch(() => undefined);
                }}
              >
                Retry local backup
              </Button>
            </>
          ) : null}
          {monitorError ? <p className="record-warn">{monitorError}</p> : null}
          {hydrateError ? <p className="record-warn">{hydrateError}</p> : null}
          {transportError ? (
            <p className="record-warn">{transportError}</p>
          ) : null}
        </div>
        {snapshot ? (
          <Roster participants={snapshot.participants} />
        ) : (
          <p>No live room snapshot yet. Mint a record room from Share…</p>
        )}
        {snapshot ? (
          <LiveComments
            snapshot={snapshot}
            me={host ?? null}
            note={liveComments.note}
            onNote={liveComments.setNote}
            onMarker={liveComments.postMarker}
            onSubmitNote={liveComments.submitNote}
          />
        ) : null}
        {!canStart &&
        (blockers.length > 0 || (!localStorageReady && !sinkError)) ? (
          <p className="record-warn">
            {[
              ...blockers,
              ...(!localStorageReady && !sinkError
                ? [LOCAL_KEEPER_PENDING_COPY]
                : []),
            ].join(", ")}
          </p>
        ) : null}
        {host ? (
          <label className="cluster">
            <input
              type="checkbox"
              checked={host.muted}
              onChange={(e) =>
                sendRecordHostCommand("SetMuted", { muted: e.target.checked })
              }
            />
            Mute
          </label>
        ) : null}
        <div className="cluster">
          <Button
            variant="primary"
            type="button"
            disabled={!canStart || transportBusy || capturingRoomTone}
            onClick={() => {
              if (capturingRoomTone) {
                roomTone.skip();
              }
              runTransport("record.start");
            }}
          >
            Start
          </Button>
          <Button
            type="button"
            disabled={!recording || transportBusy}
            onClick={() => runTransport("record.pause")}
          >
            Pause
          </Button>
          <Button
            type="button"
            disabled={!paused || transportBusy}
            onClick={() => runTransport("record.resume")}
          >
            Resume
          </Button>
          <Button
            variant="danger"
            type="button"
            disabled={(!recording && !paused) || transportBusy}
            onClick={() => runTransport("record.stop")}
          >
            Stop
          </Button>
          <Button
            type="button"
            disabled={transportBusy}
            onClick={() => runTransport("record.land")}
          >
            {landFailed ? "Retry land" : "Land"}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setRecordPanelOpen(false);
              setShareDialogOpen(true);
            }}
          >
            Copy links…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
