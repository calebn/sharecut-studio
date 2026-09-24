import { useEffect, useId, useMemo, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { useDaw } from "../state/useDaw";
import { Button, CommandButton, Dialog } from "../ui";
import { errorMessage } from "../utils/apiError";
import { startBlockers } from "./blockers";
import { HostUploadRoster } from "./HostUploadRoster";
import {
  prepareHostKeeperStorage,
  retryHostKeeperStorage,
} from "./hostKeeperStorage";
import { useRecordHostStore } from "./hostStore";
import { submitHostRecordTransport } from "./hostTransport";
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
import { RecIndicator } from "./RecIndicator";
import { RoomToneCapture } from "./RoomToneCapture";
import { Roster } from "./Roster";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import {
  HEARING_COPY,
  hostReconnectPauseCopyFromSnapshot,
  LOCAL_KEEPER_COPY,
  LOCAL_KEEPER_PENDING_COPY,
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
}: Props) {
  const micHintId = useId();
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    projectPath,
    setShareDialogOpen,
  } = useDaw();
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const blockers = startBlockers(snapshot);
  const state = snapshot?.state;
  const recording = state === "recording";
  const paused = state === "paused";
  const captureUnavailable = recording && micStatus !== null && stream === null;
  useEffect(() => {
    if ((micLost || captureUnavailable) && !recordPanelOpen) {
      setRecordPanelOpen(true);
    }
  }, [captureUnavailable, micLost, recordPanelOpen, setRecordPanelOpen]);
  const host = snapshot?.participants.find(
    (person) => person.participant_id === "p_host",
  );
  const connected = useRecordHostStore((s) => s.connected);
  const liveComments = useRecordLiveComments({
    token: HOST_COMMENT_QUEUE_TOKEN,
    snapshot,
    me: host ?? null,
    connected,
    send: (commandType, payload, commandId) =>
      sendRecordHostCommand(commandType, payload, commandId),
  });
  const [transportError, setTransportError] = useState<string | null>(null);
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
    captureExpected: stream != null,
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

  const runTransport = (commandType: string) => {
    setTransportBusy(true);
    setTransportError(null);
    void submitHostRecordTransport(commandType)
      .catch((err: unknown) => {
        setTransportError(errorMessage(err));
      })
      .finally(() => {
        setTransportBusy(false);
      });
  };

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
      closeDisabled={uploadBlocking || micLost || captureUnavailable}
    >
      <div className="stack record-panel">
        {snapshot ? (
          <RecIndicator
            snapshot={snapshot}
            captureFailed={
              !!keeperError || (captureUnavailable && micStatus !== "prompting")
            }
            capturePending={captureUnavailable && micStatus === "prompting"}
          />
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
          {recordingLocally && !keeperError ? <p>{LOCAL_KEEPER_COPY}</p> : null}
          {micLost ? <MicLossNotice onRetry={onRetryMic} /> : null}
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
              runTransport("Start");
            }}
          >
            Start
          </Button>
          <Button
            type="button"
            disabled={!recording || transportBusy}
            onClick={() => runTransport("Pause")}
          >
            Pause
          </Button>
          <Button
            type="button"
            disabled={!paused || transportBusy}
            onClick={() => runTransport("Resume")}
          >
            Resume
          </Button>
          <Button
            variant="danger"
            type="button"
            disabled={(!recording && !paused) || transportBusy}
            onClick={() => runTransport("Stop")}
          >
            Stop
          </Button>
          <CommandButton commandId="record.land" disabled={transportBusy}>
            {landFailed ? "Retry land" : "Land"}
          </CommandButton>
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
