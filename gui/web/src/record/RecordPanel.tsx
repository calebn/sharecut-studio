import { useEffect, useId, useMemo, useRef, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { Button, Dialog } from "../ui";
import { errorMessage } from "../utils/apiError";
import { sourceIdPointToTimeline } from "../utils/timebase";
import { HostUploadRoster } from "./HostUploadRoster";
import {
  landGate,
  START_FIX_LABEL,
  type StartFix,
  startBlockerItems,
  TAKE_CONTROL,
} from "./hostControls";
import {
  prepareHostKeeperStorage,
  retryHostKeeperStorage,
} from "./hostKeeperStorage";
import { useRecordHostStore } from "./hostStore";
import { sendRecordHostCommand } from "./hostWire";
import { LiveComments } from "./LiveComments";
import { HOST_COMMENT_QUEUE_TOKEN } from "./liveCommentQueue";
import { MicLossNotice } from "./MicLossNotice";
import { MicMeter } from "./MicMeter";
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
import { StopTakeControl } from "./StopTakeControl";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import { TakeClippingReport } from "./TakeClippingReport";
import {
  captureAttention,
  HEARING_COPY,
  hostReconnectPauseCopyFromSnapshot,
  LOCAL_KEEPER_COPY,
  RECORD_ROOM_RECONNECTING_COPY,
  recordSourceId,
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

/** Commands whose success the panel shows in place (a copied link is invisible otherwise). */
const SHOWN_RESULTS = new Set(["record.createRoom", "record.copyGuestLink"]);

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
  const blockersId = useId();
  const landReasonId = useId();
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    shareDialogOpen,
    projectPath,
    setShareDialogOpen,
    project,
    selectClip,
    setPlayheadSec,
  } = useDaw((s) => ({
    recordPanelOpen: s.recordPanelOpen,
    setRecordPanelOpen: s.setRecordPanelOpen,
    shareDialogOpen: s.shareDialogOpen,
    projectPath: s.projectPath,
    setShareDialogOpen: s.setShareDialogOpen,
    project: s.project,
    selectClip: s.selectClip,
    setPlayheadSec: s.setPlayheadSec,
  }));
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const takeClipping = useRecordHostStore((s) => s.takeClipping);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
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
  const hasRemovedParticipant =
    snapshot?.participants.some((person) => person.removed) ?? false;
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
  /** Whether a record room exists, as the last state read found it. */
  const [roomLookup, setRoomLookup] = useState<
    "checking" | "none" | "found" | "failed"
  >("checking");
  const [lookupNonce, setLookupNonce] = useState(0);
  /** The last record command's announcement, shown in the panel as its visible twin. */
  const [doneNotice, setDoneNotice] = useState<string | null>(null);
  const [transportBusy, setTransportBusy] = useState(false);
  const sink = useRecordHostStore((s) => s.keeperSink);
  const sinkError = useRecordHostStore((s) => s.keeperStorageError);
  const [uploadRetryNonce, setUploadRetryNonce] = useState(0);
  useEffect(() => {
    void prepareHostKeeperStorage().catch(() => undefined);
  }, []);
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
    uploadAvailable: uploadTransport !== null,
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
  const hostSegments = useHostUploadSegments(uploadTransport, !!snapshot);
  const control = snapshot ? TAKE_CONTROL[snapshot.state] : null;
  const blockers = snapshot
    ? startBlockerItems(snapshot, {
        storageReady: sink !== null,
        storageError: sinkError,
        capturingRoomTone: roomTone.status === "capturing",
      })
    : [];
  const startBlocked =
    control?.commandId === "record.start" && blockers.length > 0;
  const land =
    snapshot && snapshot.take_index >= 0
      ? landGate(snapshot, hostSegments)
      : null;
  const startFixes: Record<StartFix, () => void> = {
    copyGuestLink: () => runCommand("record.copyGuestLink"),
    retryStorage: () => {
      void retryHostKeeperStorage().catch(() => undefined);
    },
  };

  // Every button runs the same command as the keyboard and palette: record.* owns clearing, storing and announcing errors; transportBusy blocks double sends.
  const runCommand = (commandId: string) => {
    if (transportBusy) {
      return;
    }
    setTransportBusy(true);
    setDoneNotice(null);
    void executePointerCommand(commandId, {})
      .then((result) => {
        if (result.status === "ok" && SHOWN_RESULTS.has(commandId)) {
          setDoneNotice(useDawStore.getState().statusAnnouncement);
        }
      })
      .finally(() => {
        setTransportBusy(false);
      });
  };

  // A pressed control can unmount when the room changes state (Stop take, Start); keep focus on the take control.
  const takeControlRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!state) {
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body) {
      takeControlRef.current?.focus({ preventScroll: true });
    }
  }, [state]);

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
        if (cancelled) {
          return;
        }
        if (!snap) {
          // The room was never created or has ended: drop any stale snapshot.
          setSnapshot(null);
          setRoomLookup("none");
          return;
        }
        setRoomLookup("found");
        const current = useRecordHostStore.getState().snapshot;
        if (shouldApplyRecordSnapshot(snap, current)) {
          setSnapshot(snap);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoomLookup("failed");
          setHydrateError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [recordPanelOpen, projectPath, setSnapshot, lookupNonce]);

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
        {!snapshot && roomLookup === "none" ? (
          <div className="stack record-empty">
            <p>
              No record room yet. Creating one copies a guest link you can send.
            </p>
            <div className="cluster">
              <Button
                variant="primary"
                aria-disabled={transportBusy || undefined}
                onClick={() => runCommand("record.createRoom")}
              >
                Create record room
              </Button>
            </div>
          </div>
        ) : null}
        {!snapshot && roomLookup === "failed" ? (
          <div className="cluster record-empty">
            <Button
              aria-disabled={transportBusy || undefined}
              onClick={() => setLookupNonce((value) => value + 1)}
            >
              Check again
            </Button>
          </div>
        ) : null}
        {!snapshot && roomLookup === "checking" ? (
          <p role="status">Looking for a record room…</p>
        ) : null}
        {snapshot ? (
          <RecIndicator
            snapshot={snapshot}
            capture={capture}
            offline={offline}
            clipping={(takeClipping?.regions.length ?? 0) > 0}
          />
        ) : null}
        {offline ? (
          <p className="record-warn" role="status">
            {RECORD_ROOM_RECONNECTING_COPY}
          </p>
        ) : null}
        {snapshot ? <MicMeter stream={stream} label="Your mic level" /> : null}
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
            captureReady={sink !== null && roomTone.captureReady}
            onRecord={roomTone.record}
            onSkip={roomTone.skip}
            onRetry={roomTone.retry}
            primary={false}
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
          {snapshot ? (
            <TakeClippingReport
              report={takeClipping}
              roomState={snapshot.state}
              jumpFor={(region) => {
                const hit = project
                  ? sourceIdPointToTimeline(
                      project.clips.tracks,
                      recordSourceId(
                        snapshot.session_id,
                        snapshot.take_index,
                        "p_host",
                        region.segmentIndex,
                      ),
                      region.segmentStartMs / 1000,
                    )
                  : null;
                if (!hit) {
                  return null;
                }
                return () => {
                  selectClip(hit.clip.id, hit.trackId);
                  setPlayheadSec(hit.timelineSec);
                  setRecordPanelOpen(false);
                };
              }}
            />
          ) : null}
          {keeperError ? (
            <>
              <p className="record-warn">
                Full-quality recording stopped: {keeperError}
              </p>
              {onRetryKeeper ? (
                <Button
                  type="button"
                  onClick={onRetryKeeper}
                  disabled={!recording}
                >
                  Retry full-quality recording
                </Button>
              ) : null}
              {!recording ? (
                <p>
                  {paused
                    ? "Resume the take before retrying full-quality recording."
                    : "Start a new take before retrying full-quality recording."}
                </p>
              ) : null}
            </>
          ) : null}
          {sinkError && control?.stop ? (
            <>
              <p className="record-warn">{sinkError}</p>
              <Button
                type="button"
                onClick={() => {
                  void retryHostKeeperStorage().catch(() => undefined);
                }}
              >
                Retry storage check
              </Button>
            </>
          ) : null}
          {monitorError ? <p className="record-warn">{monitorError}</p> : null}
          {hydrateError ? <p className="record-warn">{hydrateError}</p> : null}
          {transportError ? (
            <p className="record-warn">{transportError}</p>
          ) : null}
        </div>
        <UploadStatus
          progress={upload}
          stopped={state === "stopped"}
          segmentList={false}
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
        {snapshot ? (
          hasRemovedParticipant ? (
            <p className="record-warn">
              A removed participant’s invite is closed to new participants. Use
              Copy links… to replace that role’s link; existing recording access
              remains available to participants who still hold a valid lease.
            </p>
          ) : null
        ) : null}
        {snapshot ? <Roster participants={snapshot.participants} /> : null}
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
        {snapshot ? (
          <div className="cluster">
            <Button
              onClick={() => {
                setRecordPanelOpen(false);
                setShareDialogOpen(true);
              }}
            >
              Copy links…
            </Button>
          </div>
        ) : null}
        {snapshot && control ? (
          <section className="stack record-controls" aria-label="Take controls">
            {host ? (
              <label className="cluster record-mute">
                <input
                  type="checkbox"
                  checked={host.muted}
                  onChange={(e) =>
                    sendRecordHostCommand("SetMuted", {
                      muted: e.target.checked,
                    })
                  }
                />
                Mute my mic
              </label>
            ) : null}
            <div className="cluster">
              <Button
                ref={takeControlRef}
                variant={
                  control.commandId === "record.pause" ? "default" : "primary"
                }
                disabled={startBlocked}
                aria-disabled={transportBusy || undefined}
                aria-describedby={startBlocked ? blockersId : undefined}
                onClick={() => runCommand(control.commandId)}
              >
                {control.label}
              </Button>
              {land ? (
                <Button
                  disabled={!land.enabled}
                  aria-disabled={transportBusy || undefined}
                  aria-describedby={land.enabled ? undefined : landReasonId}
                  onClick={() => runCommand("record.land")}
                >
                  {land.label}
                </Button>
              ) : null}
            </div>
            {startBlocked ? (
              <ul id={blockersId} className="record-blockers">
                {blockers.map((item) => (
                  <li key={item.key}>
                    <span>{item.text}</span>
                    {item.fix ? (
                      <Button
                        aria-disabled={transportBusy || undefined}
                        onClick={startFixes[item.fix]}
                      >
                        {START_FIX_LABEL[item.fix]}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {doneNotice ? <p className="record-hint">{doneNotice}</p> : null}
            {land && !land.enabled ? (
              <p id={landReasonId} className="record-hint">
                {land.reason}
              </p>
            ) : null}
            {control.stop ? (
              <StopTakeControl
                busy={transportBusy}
                onStop={() => runCommand("record.stop")}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
