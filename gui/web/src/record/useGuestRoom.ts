import { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopCloseGuard } from "../desktop/useDesktopCloseGuard";
import { errorMessage } from "../utils/apiError";
import { readLocal, writeLocal } from "../utils/storage";
import {
  type ByteSink,
  createOpfsSink,
  OpfsUnavailableError,
} from "./keeper/store";
import { useKeeperCapture } from "./keeper/useKeeperCapture";
import { useRecordMonitor } from "./monitor/useRecordMonitor";
import { loadRecordBootstrap, type RecordBootstrap } from "./recordBootstrap";
import { OPFS_UNAVAILABLE_COPY, UPLOAD_SINK_ERROR_COPY } from "./types";
import { guestRecordUploadTransport } from "./upload/http";
import { useKeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import { useLocalKeeper } from "./upload/useLocalKeeper";
import {
  keeperCaptureSettled,
  useRecordUpload,
} from "./upload/useRecordUpload";
import { useMicPermission } from "./useMicPermission";
import { useRecordLiveComments } from "./useRecordLiveComments";
import {
  isRecordAccessEnded,
  RECORD_INVITE_CLOSED,
  useRecordSync,
} from "./useRecordSync";
import { useRoomToneCapture } from "./useRoomToneCapture";
import { usePastTakeClipping, useTakeClipping } from "./useTakeClipping";

function storageKey(token: string, suffix: string): string {
  return `record:${token}:${suffix}`;
}

export function useGuestRoom(
  token: string,
  { rejoining = false }: { rejoining?: boolean } = {},
) {
  const [bootstrap, setBootstrap] = useState<RecordBootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [name, setName] = useState(
    () => readLocal(storageKey(token, "name")) || "",
  );
  const [headphonesOk, setHeadphonesOk] = useState(false);
  const [deviceId, setDeviceId] = useState(
    () => readLocal(storageKey(token, "mic")) || "",
  );
  const [producerJoined, setProducerJoined] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setBootError(null);
    setBootstrap(null);
    loadRecordBootstrap(token, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setBootstrap(data);
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setBootError(errorMessage(e));
      });
    return () => {
      controller.abort();
    };
  }, [token]);

  useEffect(() => {
    writeLocal(storageKey(token, "name"), name);
  }, [name, token]);

  const producer = bootstrap?.role === "producer";
  const heading = producer ? "Producer (not recorded)" : "Join the room";
  const episodeName = bootstrap?.episode.name.trim() ?? "";

  useEffect(() => {
    if (!bootstrap) {
      return;
    }
    const previous = document.title;
    document.title = episodeName ? `${heading} | ${episodeName}` : heading;
    return () => {
      document.title = previous;
    };
  }, [bootstrap, episodeName, heading]);

  const syncName = name.trim() || (producer ? "Producer" : "Guest");
  const { snapshot, me, send, error, clearError, connected, lease } =
    useRecordSync(
      token,
      syncName,
      !!bootstrap && (!producer || producerJoined),
    );
  const accessEnded = isRecordAccessEnded(error);
  const inviteClosed = error === RECORD_INVITE_CLOSED;
  const liveComments = useRecordLiveComments({
    token,
    snapshot,
    me,
    connected,
    send,
    captureKeys: true,
  });

  const micEnabled =
    !producer &&
    !accessEnded &&
    error !== "room_full" &&
    (me?.consented !== false || rejoining);
  const mic = useMicPermission(micEnabled, deviceId);
  const staleMic = mic.staleDeviceId !== null;
  useEffect(() => {
    // One owner for the saved mic: a dead id is forgotten in storage without
    // re-opening the stream (setDeviceId would); useMicStream skips it on Retry.
    writeLocal(storageKey(token, "mic"), staleMic ? "" : deviceId);
  }, [deviceId, staleMic, token]);
  const [sink, setSink] = useState<ByteSink | null>(null);
  const [sinkError, setSinkError] = useState<string | null>(null);
  const [storageAttempt, setStorageAttempt] = useState(0);
  const retryStorage = useCallback(() => setStorageAttempt((n) => n + 1), []);
  const storageRequired = !!(
    bootstrap?.build.capture || bootstrap?.build.upload
  );
  useEffect(() => {
    if (!storageRequired || producer) {
      setSink(null);
      setSinkError(null);
      return;
    }
    let cancelled = false;
    setSink(null);
    setSinkError(null);
    void createOpfsSink()
      .then((next) => {
        if (!cancelled) {
          setSink(next);
          setSinkError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSinkError(
            error instanceof OpfsUnavailableError
              ? OPFS_UNAVAILABLE_COPY
              : UPLOAD_SINK_ERROR_COPY,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storageRequired, producer, storageAttempt]);
  const captureEnabled =
    !!bootstrap?.build.capture &&
    !producer &&
    !accessEnded &&
    me?.consented === true;
  const keeper = useKeeperCapture({
    enabled: captureEnabled && sink !== null,
    role: "guest",
    snapshot,
    participantId: me?.participant_id ?? null,
    muted: me?.muted ?? false,
    consented: me?.consented ?? null,
    stream: mic.stream,
    sink,
    reportSegments: (takeIndex, segments) =>
      send("SegmentReport", { take_index: takeIndex, segments }),
  });
  useDesktopCloseGuard(
    keeper.recordingLocally ||
      keeper.finalizing ||
      (captureEnabled &&
        (snapshot?.state === "recording" || snapshot?.state === "paused")),
    "guest",
    snapshot !== null,
  );
  const monitor = useRecordMonitor({
    enabled: !!bootstrap?.build.monitor && !!me && connected && !accessEnded,
    localId: me?.participant_id ?? null,
    role: producer ? "producer" : "guest",
    snapshot,
    localStream: producer || me?.consented !== true ? null : mic.stream,
    muted: me?.muted ?? false,
    send: (payload) => send("Signal", payload),
  });
  const uploadTransport = useMemo(() => {
    if (
      !bootstrap?.build.upload ||
      producer ||
      accessEnded ||
      !me?.participant_id ||
      !lease
    ) {
      return null;
    }
    return guestRecordUploadTransport(token, me.participant_id, lease);
  }, [
    bootstrap?.build.upload,
    producer,
    accessEnded,
    me?.participant_id,
    lease,
    token,
  ]);
  const [uploadRetryNonce, setUploadRetryNonce] = useState(0);
  const resumeUpload = useCallback(
    () => setUploadRetryNonce((value) => value + 1),
    [],
  );
  const captureSettled = keeperCaptureSettled(keeper);
  const upload = useRecordUpload({
    enabled:
      !!bootstrap?.build.upload &&
      !producer &&
      !accessEnded &&
      (me?.consented === true || snapshot?.state === "stopped"),
    roomState: snapshot?.state,
    captureSettled,
    sessionId: snapshot?.session_id ?? null,
    takeIndex: snapshot?.take_index ?? 0,
    participantId: me?.participant_id ?? null,
    transport: uploadTransport,
    sink,
    retryNonce: uploadRetryNonce,
    captureExpected: me?.consented === true,
  });
  const takeClipping = useTakeClipping({
    sink,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    takeIndex: snapshot?.take_index ?? -1,
    roomState: snapshot?.state,
    captureSettled,
    live: keeper.clipping,
  });
  const pastClipping = usePastTakeClipping({
    sink,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    beforeTake: snapshot?.take_index ?? 0,
  });
  const takeClippings = useMemo(
    () =>
      takeClipping
        ? { ...pastClipping, [takeClipping.takeIndex]: takeClipping }
        : pastClipping,
    [pastClipping, takeClipping],
  );
  const keeperActions = useKeeperRecoveryActions({
    sink,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    takeIndex: snapshot?.take_index ?? null,
    uploadAvailable: uploadTransport !== null,
    recoverAllowed:
      (snapshot?.state === "stopped" || accessEnded) && captureSettled,
    onRecovered: () => setUploadRetryNonce((value) => value + 1),
  });
  const localRecording = useLocalKeeper({
    sink,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    takeIndex: snapshot?.take_index ?? null,
    recheck: `${accessEnded}:${captureSettled}:${keeperActions.busy}:${uploadRetryNonce}`,
  });
  const roomTone = useRoomToneCapture({
    enabled:
      !!bootstrap?.build.upload &&
      !producer &&
      !accessEnded &&
      !!me?.participant_id &&
      me.consented !== false &&
      (snapshot?.state === "lobby" || snapshot?.state === "stopped"),
    canUpload: !accessEnded && me?.consented === true,
    stream: mic.stream,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    sink,
    transport: uploadTransport,
  });

  const meId = me?.participant_id;
  const myName = me?.display_name;

  useEffect(() => {
    if (meId && name.trim() && name.trim() !== myName) {
      send("UpdateName", { display_name: name.trim() });
    }
  }, [meId, myName, name, send]);

  useEffect(() => {
    if (meId && !producer) {
      send("HeadphonesAck", { ok: headphonesOk });
    }
  }, [headphonesOk, meId, producer, send]);

  const view = useMemo(() => {
    if (error === "room_full") {
      return "full" as const;
    }
    if (me?.consented === false && snapshot && snapshot.state !== "lobby") {
      return "declined" as const;
    }
    if (!producer && me?.consented !== true) {
      return "lobby" as const;
    }
    if (snapshot && (producer || me?.consented === true)) {
      return "room" as const;
    }
    return "lobby" as const;
  }, [error, me, producer, snapshot]);

  return {
    bootstrap,
    bootError,
    producer,
    heading,
    episodeName,
    snapshot,
    me,
    send,
    connected,
    error,
    clearError,
    accessEnded,
    inviteClosed,
    mic,
    staleMic,
    sink,
    sinkError,
    storageRequired,
    retryStorage,
    keeper,
    monitor,
    upload,
    uploadTransport,
    takeClipping,
    takeClippings,
    keeperActions,
    localRecording,
    roomTone,
    liveComments,
    captureSettled,
    view,
    name,
    setName,
    headphonesOk,
    setHeadphonesOk,
    deviceId,
    setDeviceId,
    producerJoined,
    setProducerJoined,
    resumeUpload,
  };
}

export type GuestRoom = ReturnType<typeof useGuestRoom>;
