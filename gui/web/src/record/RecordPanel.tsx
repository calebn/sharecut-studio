import { useEffect, useId, useMemo, useRef, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { executePointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import { sourceIdPointToTimeline } from "../utils/timebase";
import {
  landGate,
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
import type { TakeClipRegion } from "./keeper/clipRegions";
import { HOST_COMMENT_QUEUE_TOKEN } from "./liveCommentQueue";
import {
  copyForMicStatus,
  type MicPermissionStatus,
  micGrantFailed,
} from "./micPermission";
import { RecordPanelView } from "./RecordPanelView";
import {
  captureAttention,
  hostReconnectPauseCopyFromSnapshot,
  recordSourceId,
  shouldApplyRecordSnapshot,
} from "./types";
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
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    shareDialogOpen,
    projectPath,
    setShareDialogOpen,
    project,
    selectClip,
  } = useDaw((s) => ({
    recordPanelOpen: s.chrome.recordPanelOpen,
    setRecordPanelOpen: s.setRecordPanelOpen,
    shareDialogOpen: s.chrome.shareDialogOpen,
    projectPath: s.projectPath,
    setShareDialogOpen: s.setShareDialogOpen,
    project: s.project,
    selectClip: s.selectClip,
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

  const onRetryStorage = () => {
    void retryHostKeeperStorage().catch(() => undefined);
  };
  const jumpFor = (region: TakeClipRegion) => {
    if (!snapshot) {
      return null;
    }
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
      void seekTransport(hit.timelineSec);
      setRecordPanelOpen(false);
    };
  };

  return (
    <RecordPanelView
      open={recordPanelOpen}
      onClose={() => setRecordPanelOpen(false)}
      closeDisabled={
        uploadBlocking || micLossNeedsAttention || captureUnavailable
      }
      snapshot={snapshot}
      roomLookup={roomLookup}
      host={host}
      onCommand={runCommand}
      onCheckAgain={() => setLookupNonce((value) => value + 1)}
      transportBusy={transportBusy}
      takeControlRef={takeControlRef}
      control={control}
      land={land}
      startBlocked={startBlocked}
      blockers={blockers}
      blockersId={blockersId}
      startFixes={startFixes}
      doneNotice={doneNotice}
      capture={capture}
      offline={offline}
      takeClipping={takeClipping}
      jumpFor={jumpFor}
      stream={stream}
      storageReady={sink !== null}
      roomTone={roomTone}
      reconnectCopy={reconnectCopy}
      recordingLocally={recordingLocally}
      keeperError={keeperError}
      onRetryKeeper={onRetryKeeper}
      noAudioNeedsAttention={noAudioNeedsAttention}
      micLossNeedsAttention={micLossNeedsAttention}
      micLost={micLost}
      onRetryMic={onRetryMic}
      onCheckMic={onCheckMic}
      micCheckFailed={micCheckFailed}
      hearing={hearing}
      micHintId={micHintId}
      micCopy={micCopy}
      micPending={micPending}
      micFailed={micFailed}
      micStatus={micStatus}
      micError={micError}
      sinkError={sinkError}
      onRetryStorage={onRetryStorage}
      monitorError={monitorError}
      hydrateError={hydrateError}
      transportError={transportError}
      upload={upload}
      keeperActions={keeperActions}
      hostSegments={hostSegments}
      onResumeUpload={() => setUploadRetryNonce((value) => value + 1)}
      hasRemovedParticipant={hasRemovedParticipant}
      liveComments={liveComments}
      onCopyLinks={() => {
        setRecordPanelOpen(false);
        setShareDialogOpen(true);
      }}
      onMuteChange={(muted) => sendRecordHostCommand("SetMuted", { muted })}
    />
  );
}
