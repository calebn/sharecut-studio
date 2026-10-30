import { useCallback, useEffect, useMemo, useState } from "react";
import { hostRecordUploadTransport, loadHostRecordState } from "../api";
import { executePointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import { sourceIdPointToTimeline } from "../utils/timebase";
import {
  endGate,
  landGate,
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
import { HOST_PARTICIPANT_ID } from "./roomPeople";
import {
  captureAttention,
  hostReconnectPauseCopyFromSnapshot,
  recordSourceId,
  shouldApplyRecordSnapshot,
} from "./types";
import { useKeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import {
  keeperCaptureSettled,
  useHostUploadSegments,
  useRecordUpload,
} from "./upload/useRecordUpload";
import { useEndSession } from "./useEndSession";
import { NO_OUTPUT, type OutputDevice } from "./useOutputDevice";
import { useRecordLiveComments } from "./useRecordLiveComments";
import { useRoomToneCapture } from "./useRoomToneCapture";

export type RecordRoomLookup = "checking" | "none" | "found" | "failed";

const SHOWN_RESULTS = new Set(["record.createRoom", "record.copyGuestLink"]);
// A refusal with no thrown error would otherwise leave the person guessing.
const SHOWN_REFUSALS = new Set(["record.setTarget"]);

const NO_DEVICES: MediaDeviceInfo[] = [];

export type HostRoomCapture = {
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
  devices?: MediaDeviceInfo[];
  deviceId?: string;
  staleMic?: boolean;
  onDeviceChange?: (deviceId: string) => void;
  output?: OutputDevice;
};

export function useHostRoom(
  input: HostRoomCapture = {},
  options: { hydrate?: boolean } = {},
) {
  const hydrate = options.hydrate ?? true;
  const {
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
    devices = NO_DEVICES,
    deviceId = "",
    staleMic = false,
    onDeviceChange,
    output = NO_OUTPUT,
  } = input;
  const { projectPath, project, selectClip } = useDaw((s) => ({
    projectPath: s.projectPath,
    project: s.project,
    selectClip: s.selectClip,
  }));
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const takeClipping = useRecordHostStore((s) => s.takeClipping);
  const setSnapshot = useRecordHostStore((s) => s.setSnapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const connected = useRecordHostStore((s) => s.connected);
  const dropped = useRecordHostStore((s) => s.dropped);
  const transportError = useRecordHostStore((s) => s.transportError);
  const setTransportError = useRecordHostStore((s) => s.setTransportError);
  const sink = useRecordHostStore((s) => s.keeperSink);
  const sinkError = useRecordHostStore((s) => s.keeperStorageError);
  const state = snapshot?.state;
  const recording = state === "recording";
  const paused = state === "paused";
  const captureUnavailable =
    recording && (captureHealth === "pending" || captureHealth === "failed");
  const micLossNeedsAttention = (recording || paused) && micLost;
  const { capture, noAudio: noAudioNeedsAttention } = captureAttention(
    state,
    keeperError ? "failed" : captureHealth,
    micLossNeedsAttention,
  );
  const host = snapshot?.participants.find(
    (person) => person.participant_id === "p_host",
  );
  const hasRemovedParticipant =
    snapshot?.participants.some((person) => person.removed) ?? false;
  const liveComments = useRecordLiveComments({
    token: HOST_COMMENT_QUEUE_TOKEN,
    snapshot,
    me: host ?? null,
    connected,
    send: (commandType, payload, commandId) =>
      sendRecordHostCommand(commandType, payload, commandId),
  });
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [roomLookup, setRoomLookup] = useState<RecordRoomLookup>("checking");
  const [lookupNonce, setLookupNonce] = useState(0);
  const [doneNotice, setDoneNotice] = useState<string | null>(null);
  const [transportBusy, setTransportBusy] = useState(false);
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
  const retryStorage = useCallback(() => {
    void retryHostKeeperStorage().catch(() => undefined);
  }, []);

  const runCommand = (
    commandId: string,
    args: Record<string, unknown> = {},
  ) => {
    if (transportBusy) {
      return;
    }
    setTransportBusy(true);
    setDoneNotice(null);
    void executePointerCommand(commandId, args)
      .then((result) => {
        if (result.status === "ok" && SHOWN_RESULTS.has(commandId)) {
          setDoneNotice(useDawStore.getState().statusAnnouncement);
        }
        if (result.status === "disabled" && SHOWN_REFUSALS.has(commandId)) {
          setTransportError(result.reason);
        }
      })
      .finally(() => {
        setTransportBusy(false);
      });
  };

  useEffect(
    () => () => {
      setTransportError(null);
    },
    [projectPath, setTransportError],
  );

  useEffect(() => {
    setRoomLookup("checking");
    setDoneNotice(null);
  }, [projectPath]);

  useEffect(() => {
    if (!hydrate || !projectPath) {
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
  }, [hydrate, projectPath, setSnapshot, lookupNonce]);

  const recheck = useCallback(() => setLookupNonce((value) => value + 1), []);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const end = snapshot
    ? endGate(snapshot, hostSegments)
    : { enabled: false as const, reason: "" };
  const endSession = useEndSession({
    projectPath,
    sessionId: snapshot?.session_id ?? null,
    canEnd: end.enabled,
    onEnded: () => {
      setSnapshot(null);
      setRoomLookup("none");
      announceStatus("Session ended");
    },
    onFailed: setTransportError,
  });
  const resumeUpload = useCallback(
    () => setUploadRetryNonce((value) => value + 1),
    [],
  );
  const offline = dropped && (state === "recording" || state === "paused");
  const reconnectCopy = snapshot
    ? hostReconnectPauseCopyFromSnapshot(snapshot)
    : null;
  const micCopy =
    micStatus && micStatus !== "lost" ? copyForMicStatus(micStatus) : null;
  const micFailed =
    micStatus && micStatus !== "lost" ? micGrantFailed(micStatus) : false;

  const jumpFor = (
    region: TakeClipRegion,
    takeIndex?: number,
    participantId = HOST_PARTICIPANT_ID,
  ): (() => void) | null => {
    if (!snapshot) {
      return null;
    }
    const hit = project
      ? sourceIdPointToTimeline(
          project.clips.tracks,
          recordSourceId(
            snapshot.session_id,
            takeIndex ?? snapshot.take_index,
            participantId,
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
    };
  };

  return {
    capture: {
      recordingLocally,
      keeperFinalizing,
      keeperError,
      onRetryKeeper,
      micError,
      micPending,
      micStatus,
      hearing,
      monitorError,
      stream,
      micLost,
      onRetryMic,
      onCheckMic,
      micCheckFailed,
      devices,
      deviceId,
      staleMic,
      onDeviceChange,
      output,
    },
    snapshot,
    state,
    host,
    hasRemovedParticipant,
    connected,
    dropped,
    offline,
    takeClipping,
    transportError,
    setTransportError,
    hydrateError,
    roomLookup,
    recheck,
    endSession: { ...endSession, gate: end },
    doneNotice,
    transportBusy,
    runCommand,
    sink,
    sinkError,
    upload,
    keeperActions,
    roomTone,
    hostSegments,
    control,
    blockers,
    startBlocked,
    land,
    retryStorage,
    resumeUpload,
    liveComments,
    captureAttention: capture,
    captureUnavailable,
    micLossNeedsAttention,
    noAudioNeedsAttention,
    reconnectCopy,
    micCopy,
    micFailed,
    jumpFor,
    setMuted: (muted: boolean) => sendRecordHostCommand("SetMuted", { muted }),
  };
}

export type HostRoom = ReturnType<typeof useHostRoom>;
