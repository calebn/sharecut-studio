import { useEffect, useMemo, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { useDaw } from "../state/useDaw";
import { Button, CommandButton, Dialog } from "../ui";
import { startBlockers } from "./blockers";
import { HostUploadRoster } from "./HostUploadRoster";
import { useRecordHostStore } from "./hostStore";
import { submitHostRecordTransport } from "./hostTransport";
import { sendRecordHostCommand } from "./hostWire";
import { type ByteSink, createOpfsSink } from "./keeper/store";
import { LiveComments } from "./LiveComments";
import { HOST_COMMENT_QUEUE_TOKEN } from "./liveCommentQueue";
import { MicLossNotice } from "./MicLossNotice";
import { RecIndicator } from "./RecIndicator";
import { RoomToneCapture } from "./RoomToneCapture";
import { Roster } from "./Roster";
import {
  HEARING_COPY,
  hostReconnectPauseCopyFromSnapshot,
  LOCAL_KEEPER_COPY,
  shouldApplyRecordSnapshot,
  UPLOAD_SINK_ERROR_COPY,
} from "./types";
import { UploadStatus } from "./UploadStatus";
import { downloadLocalKeepers, recoverLocalKeepers } from "./upload/recovery";
import {
  leaveBlocked,
  useHostUploadSegments,
  useRecordUpload,
} from "./upload/useRecordUpload";
import { useRecordLiveComments } from "./useRecordLiveComments";
import { useRoomToneCapture } from "./useRoomToneCapture";

type Props = {
  recordingLocally?: boolean;
  keeperError?: string | null;
  onRetryKeeper?: () => void;
  hearing?: boolean;
  monitorError?: string | null;
  stream?: MediaStream | null;
  micLost?: boolean;
  onRetryMic?: () => void;
};

export function RecordPanel({
  recordingLocally = false,
  keeperError = null,
  onRetryKeeper,
  hearing = false,
  monitorError = null,
  stream = null,
  micLost = false,
  onRetryMic,
}: Props) {
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    projectPath,
    setShareDialogOpen,
  } = useDaw();
  useEffect(() => {
    if (micLost && !recordPanelOpen) {
      setRecordPanelOpen(true);
    }
  }, [micLost, recordPanelOpen, setRecordPanelOpen]);
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const blockers = startBlockers(snapshot);
  const state = snapshot?.state;
  const canStart =
    blockers.length === 0 && (state === "lobby" || state === "stopped");
  const recording = state === "recording";
  const paused = state === "paused";
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
  const [sink, setSink] = useState<ByteSink | null>(null);
  const [sinkError, setSinkError] = useState<string | null>(null);
  const [uploadRetryNonce, setUploadRetryNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void createOpfsSink()
      .then((next) => {
        if (!cancelled) {
          setSink(next);
          setSinkError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSinkError(UPLOAD_SINK_ERROR_COPY);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const uploadTransport = useMemo(
    () => (projectPath ? hostRecordUploadTransport(projectPath) : null),
    [projectPath],
  );
  const upload = useRecordUpload({
    enabled: !!snapshot,
    roomState: snapshot?.state,
    captureSettled: !recordingLocally,
    sessionId: snapshot?.session_id ?? null,
    takeIndex: snapshot?.take_index ?? 0,
    participantId: "p_host",
    transport: uploadTransport,
    sink,
    captureExpected: stream != null,
    retryNonce: uploadRetryNonce,
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
        setTransportError(err instanceof Error ? err.message : String(err));
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
          setHydrateError(err instanceof Error ? err.message : String(err));
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

  return (
    <Dialog
      open={recordPanelOpen}
      onClose={() => setRecordPanelOpen(false)}
      title="Record room"
      closeDisabled={uploadBlocking || micLost}
    >
      <div className="stack record-panel">
        {snapshot ? (
          <RecIndicator snapshot={snapshot} captureFailed={!!keeperError} />
        ) : null}
        {snapshot &&
        (snapshot.state === "lobby" || snapshot.state === "stopped") ? (
          <RoomToneCapture
            status={roomTone.status}
            error={roomTone.error}
            micReady={!!stream}
            captureReady={roomTone.captureReady}
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
          <UploadStatus
            progress={upload}
            stopped={state === "stopped"}
            onResume={() => setUploadRetryNonce((value) => value + 1)}
            onDownload={
              sink && snapshot
                ? () => {
                    void downloadLocalKeepers(
                      sink,
                      snapshot.session_id,
                      "p_host",
                      snapshot.take_index,
                    ).catch((error: unknown) => {
                      setSinkError(
                        error instanceof Error ? error.message : String(error),
                      );
                    });
                  }
                : undefined
            }
            onRecover={
              upload.recoverable && sink && snapshot
                ? () => {
                    void recoverLocalKeepers(
                      sink,
                      snapshot.session_id,
                      "p_host",
                      snapshot.take_index,
                    )
                      .then(() => setUploadRetryNonce((value) => value + 1))
                      .catch((error: unknown) => {
                        setSinkError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      });
                  }
                : undefined
            }
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
          {sinkError ? <p className="record-warn">{sinkError}</p> : null}
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
        {!canStart && blockers.length > 0 ? (
          <p className="record-warn">{blockers.join(", ")}</p>
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
