import { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopCloseGuard } from "../desktop/useDesktopCloseGuard";
import type { HeadphonesChoice } from "../system/joinSheetModel";
import { readRecordName, writeRecordName } from "../utils/recordNamePref";
import { readLocal, removeLocal, writeLocal } from "../utils/storage";
import { tookAnyTake } from "./guestRoomModel";
import {
  type ByteSink,
  createOpfsSink,
  OpfsUnavailableError,
} from "./keeper/store";
import { useKeeperCapture } from "./keeper/useKeeperCapture";
import { useRecordMonitor } from "./monitor/useRecordMonitor";
import {
  type BootFailure,
  loadRecordBootstrap,
  type RecordBootstrap,
} from "./recordBootstrap";
import { OPFS_UNAVAILABLE_COPY, UPLOAD_SINK_ERROR_COPY } from "./types";
import { guestRecordUploadTransport } from "./upload/http";
import { useKeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import { useLocalKeeper } from "./upload/useLocalKeeper";
import {
  keeperCaptureSettled,
  useRecordUpload,
} from "./upload/useRecordUpload";
import { useLeaseFreshWhileLeft } from "./useLeaseFreshWhileLeft";
import { useMicPermission } from "./useMicPermission";
import { useOutputDevice } from "./useOutputDevice";
import { useRecordLiveComments } from "./useRecordLiveComments";
import {
  isRecordAccessEnded,
  RECORD_INVITE_CLOSED,
  type RecordSocketMode,
  useRecordSync,
} from "./useRecordSync";
import { useRoomToneCapture } from "./useRoomToneCapture";
import { usePastTakeClipping, useTakeClipping } from "./useTakeClipping";

/**
 * A guest, or a producer who pressed Join to listen, is in the room. A producer
 * only looks until then, and Not now ends the look.
 */
export function requestedRecordMode(room: {
  bootstrapped: boolean;
  producer: boolean;
  producerJoined: boolean;
  producerDismissed: boolean;
  left: boolean;
}): RecordSocketMode {
  if (!room.bootstrapped || room.left) {
    return "off";
  }
  if (!room.producer || room.producerJoined) {
    return "join";
  }
  return room.producerDismissed ? "off" : "watch";
}

function storageKey(token: string, suffix: string): string {
  return `record:${token}:${suffix}`;
}

export type KeeperIdentity = {
  sessionId: string;
  participantId: string;
  takeIndex: number;
};

export function useGuestRoom(
  token: string,
  {
    rejoining = false,
    carried = null,
  }: { rejoining?: boolean; carried?: KeeperIdentity | null } = {},
) {
  const [boot, setBoot] = useState<{
    owner: { token: string };
    bootstrap: RecordBootstrap | null;
    failure: BootFailure | null;
  }>(() => ({ owner: { token }, bootstrap: null, failure: null }));
  if (boot.owner.token !== token) {
    setBoot({ owner: { token }, bootstrap: null, failure: null });
  }
  const { owner: bootOwner, bootstrap } = boot;
  const [name, setName] = useState(readRecordName);
  const [nameTyped, setNameTyped] = useState(false);
  const typeName = useCallback((value: string) => {
    setNameTyped(true);
    setName(value);
  }, []);
  const [headphones, setHeadphones] = useState<HeadphonesChoice>("unset");
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState(
    () => readLocal(storageKey(token, "mic")) || "",
  );
  const [producerJoined, setProducerJoined] = useState(false);
  const [producerDismissed, setProducerDismissed] = useState(false);
  const [left, setLeft] = useState(false);
  const leave = useCallback(() => setLeft(true), []);
  const [declineIntent, setDeclineIntent] = useState(false);
  const declineHere = useCallback(() => setDeclineIntent(true), []);
  const clearDecline = useCallback(() => setDeclineIntent(false), []);

  useEffect(() => {
    const controller = new AbortController();
    loadRecordBootstrap(token, controller.signal).then(
      (outcome) => {
        if (!controller.signal.aborted) {
          setBoot((current) =>
            current.owner === bootOwner ? { ...current, ...outcome } : current,
          );
        }
      },
      () => undefined,
    );
    return () => {
      controller.abort();
    };
  }, [token, bootOwner]);

  const producer = bootstrap?.role === "producer";
  const episodeName = bootstrap?.episode.name.trim() ?? "";

  const [heldAsJoined, setHeldAsJoined] = useState(false);
  const syncName =
    (nameTyped || producerJoined || heldAsJoined || carried !== null
      ? name.trim()
      : "") || (producer ? "Producer" : "Guest");
  const requestedMode = requestedRecordMode({
    bootstrapped: !!bootstrap,
    producer,
    producerJoined,
    producerDismissed,
    left,
  });
  const {
    snapshot,
    me,
    send,
    error,
    clearError,
    connected,
    echoed,
    lease,
    counted,
    socketMode,
  } = useRecordSync(token, syncName, requestedMode);
  const roomConsent = me?.consented ?? null;
  const consented = declineIntent ? false : roomConsent;
  const { leaseFresh, leaseStillFresh } = useLeaseFreshWhileLeft(token, left);
  const accessEnded = isRecordAccessEnded(error);
  const inviteClosed = error === RECORD_INVITE_CLOSED;
  const joinedName = (producer ? producerJoined : consented === true)
    ? name.trim()
    : "";
  useEffect(() => {
    if (joinedName) writeRecordName(joinedName);
  }, [joinedName]);
  const liveComments = useRecordLiveComments({
    token,
    snapshot,
    me,
    connected,
    send,
    captureKeys: !!me,
  });

  const micEnabled =
    !producer &&
    !accessEnded &&
    error !== "room_full" &&
    !left &&
    (consented !== false || rejoining);
  const mic = useMicPermission(micEnabled, deviceId);
  const staleMic = mic.staleDeviceId !== null;
  useEffect(() => {
    // One owner for the saved mic: a dead id is forgotten in storage without
    // re-opening the stream (setDeviceId would); useMicStream skips it on Retry.
    writeLocal(storageKey(token, "mic"), staleMic ? "" : deviceId);
  }, [deviceId, staleMic, token]);
  const [storageAttempt, setStorageAttempt] = useState(0);
  const retryStorage = useCallback(() => setStorageAttempt((n) => n + 1), []);
  const storageRequired = !!(
    bootstrap?.build.capture || bootstrap?.build.upload
  );
  const [storage, setStorage] = useState<{
    owner: { required: boolean; producer: boolean; attempt: number };
    sink: ByteSink | null;
    error: string | null;
  }>(() => ({
    owner: { required: storageRequired, producer, attempt: storageAttempt },
    sink: null,
    error: null,
  }));
  if (
    storage.owner.required !== storageRequired ||
    storage.owner.producer !== producer ||
    storage.owner.attempt !== storageAttempt
  ) {
    setStorage({
      owner: { required: storageRequired, producer, attempt: storageAttempt },
      sink: null,
      error: null,
    });
  }
  const { owner: storageOwner, sink, error: sinkError } = storage;
  useEffect(() => {
    if (!storageRequired || producer) return;
    let cancelled = false;
    void createOpfsSink()
      .then((next) => {
        if (!cancelled) {
          setStorage((current) =>
            current.owner === storageOwner
              ? { ...current, sink: next, error: null }
              : current,
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof OpfsUnavailableError
              ? OPFS_UNAVAILABLE_COPY
              : UPLOAD_SINK_ERROR_COPY;
          setStorage((current) =>
            current.owner === storageOwner
              ? { ...current, error: message }
              : current,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storageRequired, producer, storageAttempt, storageOwner]);
  const captureEnabled =
    !!bootstrap?.build.capture &&
    !producer &&
    !accessEnded &&
    consented === true;
  const keeper = useKeeperCapture({
    enabled: captureEnabled && sink !== null,
    role: "guest",
    snapshot,
    participantId: me?.participant_id ?? null,
    muted: me?.muted ?? false,
    consented,
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
    localStream: producer || consented !== true ? null : mic.stream,
    muted: me?.muted ?? false,
    send: (payload) => send("Signal", payload),
  });
  const output = useOutputDevice(monitor);
  const uploadParticipantId = me?.participant_id;
  const uploadTransport = useMemo(() => {
    if (
      !bootstrap?.build.upload ||
      producer ||
      accessEnded ||
      !uploadParticipantId ||
      !lease
    ) {
      return null;
    }
    return guestRecordUploadTransport(token, uploadParticipantId, lease);
  }, [
    bootstrap?.build.upload,
    producer,
    accessEnded,
    uploadParticipantId,
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
      (consented === true || snapshot?.state === "stopped"),
    roomState: snapshot?.state,
    captureSettled,
    sessionId: snapshot?.session_id ?? null,
    takeIndex: snapshot?.take_index ?? 0,
    participantId: me?.participant_id ?? null,
    transport: uploadTransport,
    sink,
    retryNonce: uploadRetryNonce,
    captureExpected: consented === true,
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
  const [keeperRuns, setKeeperRuns] = useState(0);
  const [recordedThisPage, setRecordedThisPage] = useState(false);
  useEffect(() => {
    if (keeper.recordingLocally) setRecordedThisPage(true);
  }, [keeper.recordingLocally]);
  const keeperSessionId = snapshot?.session_id ?? carried?.sessionId ?? null;
  const keeperParticipantId =
    me?.participant_id ?? carried?.participantId ?? null;
  const keeperTakeIndex = snapshot?.take_index ?? carried?.takeIndex ?? null;
  const keeperIdentity = useMemo(
    () =>
      keeperSessionId &&
      keeperParticipantId &&
      keeperTakeIndex !== null &&
      keeperTakeIndex >= 0
        ? {
            sessionId: keeperSessionId,
            participantId: keeperParticipantId,
            takeIndex: keeperTakeIndex,
          }
        : null,
    [keeperSessionId, keeperParticipantId, keeperTakeIndex],
  );
  const localKeeper = useLocalKeeper({
    sink,
    sessionId: keeperSessionId,
    participantId: keeperParticipantId,
    takeIndex: keeperTakeIndex,
    recheck: `${accessEnded}:${captureSettled}:${keeperRuns}:${uploadRetryNonce}:${upload.seenSegments}:${upload.fileAck}`,
  });
  const keeperActions = useKeeperRecoveryActions({
    sink,
    sessionId: keeperSessionId,
    participantId: keeperParticipantId,
    takeIndex: keeperTakeIndex,
    uploadAvailable: uploadTransport !== null,
    recoverAllowed:
      (snapshot?.state === "stopped" || accessEnded) && captureSettled,
    localSegments: localKeeper.segments,
    captureSettled,
    onRecovered: () => setUploadRetryNonce((value) => value + 1),
    onRunEnd: () => setKeeperRuns((value) => value + 1),
  });
  const roomTone = useRoomToneCapture({
    enabled:
      !!bootstrap?.build.upload &&
      !producer &&
      !accessEnded &&
      !!me?.participant_id &&
      consented !== false &&
      (snapshot?.state === "lobby" || snapshot?.state === "stopped"),
    canUpload: !accessEnded && consented === true,
    stream: mic.stream,
    sessionId: snapshot?.session_id ?? null,
    participantId: me?.participant_id ?? null,
    sink,
    transport: uploadTransport,
  });

  const meId = me?.participant_id;
  const myName = me?.display_name;

  const nameShared = nameTyped || producerJoined || consented === true;
  const roomHoldsJoined = consented === true;
  useEffect(() => {
    setHeldAsJoined(roomHoldsJoined);
  }, [roomHoldsJoined]);
  useEffect(() => {
    if (meId && nameShared && name.trim() && name.trim() !== myName) {
      send("UpdateName", { display_name: name.trim() });
    }
  }, [meId, myName, name, nameShared, send]);

  const shareName = useCallback(() => {
    setNameTyped(true);
    const trimmed = name.trim();
    if (trimmed && trimmed !== myName) {
      send("UpdateName", { display_name: trimmed });
    }
  }, [myName, name, send]);

  useEffect(() => {
    removeLocal(storageKey(token, "name"));
  }, [token]);

  if (meId && meId !== seededFor) {
    setSeededFor(meId);
    if (me?.consented === true && headphones === "unset") {
      setHeadphones(me.headphones_ack ? "on" : "off");
    }
  }
  const ackedOn = me?.headphones_ack;
  useEffect(() => {
    if (connected && meId && !producer && headphones !== "unset") {
      const on = headphones === "on";
      if (on !== ackedOn) {
        send("HeadphonesAck", { ok: on });
      }
    }
  }, [ackedOn, connected, headphones, meId, producer, send]);

  useEffect(() => {
    if (
      producer ||
      !declineIntent ||
      !connected ||
      !echoed ||
      roomConsent === false
    ) {
      return;
    }
    send("Consent", { accepted: false });
  }, [producer, declineIntent, connected, echoed, roomConsent, send]);

  const view = useMemo(() => {
    if (error === "room_full") {
      return "full" as const;
    }
    if (consented === false && snapshot && snapshot.state !== "lobby") {
      return "declined" as const;
    }
    if (!producer && me?.consented !== true) {
      return "lobby" as const;
    }
    if (snapshot && (producer || me?.consented === true)) {
      return "room" as const;
    }
    return "lobby" as const;
  }, [consented, error, me, producer, snapshot]);

  return {
    bootstrap,
    bootError: boot.failure,
    producer,
    episodeName,
    snapshot,
    me,
    send,
    connected,
    consented,
    declineHere,
    clearDecline,
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
    output,
    upload,
    uploadTransport,
    takeClipping,
    takeClippings,
    keeperActions,
    localRecording: localKeeper.found,
    localSegments: localKeeper.segments,
    recordedHere: recordedThisPage || tookAnyTake(snapshot, me),
    localUnreadable:
      localKeeper.failed || (sink === null && sinkError !== null),
    roomTone,
    liveComments,
    captureSettled,
    view,
    name,
    setName: typeName,
    shareName,
    headphones,
    setHeadphones,
    deviceId,
    setDeviceId,
    producerJoined,
    setProducerJoined,
    producerDismissed,
    setProducerDismissed,
    socketMode,
    counted,
    resumeUpload,
    left,
    leaseFresh,
    leaseStillFresh,
    keeperIdentity,
    leave,
  };
}

export type GuestRoom = ReturnType<typeof useGuestRoom>;
