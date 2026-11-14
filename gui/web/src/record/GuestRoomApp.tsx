import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useAfter } from "../hooks/useAfter";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useElapsedSince } from "../hooks/useElapsedSince";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import { useViewportClass } from "../hooks/useViewportClass";
import { DeviceSheet } from "../system/DeviceSheet";
import { JoinSheet } from "../system/JoinSheet";
import type { JoinMicAction } from "../system/joinSheetModel";
import { RoomView } from "../system/RoomView";
import { SKELETON_RETRY_MS } from "../system/Skeleton";
import { TakesTray } from "../system/TakesTray";
import { dbToFraction } from "../ui/metering";
import { clippingGate } from "./alertGates";
import { deviceMic, deviceTone, useSheetMic } from "./deviceSheet";
import { GuestCovers } from "./GuestCovers";
import {
  guestCoverProps,
  guestHostName,
  guestRoomAlerts,
  guestRoomPhase,
  guestTakes,
  guestViewerWidth,
  joinHere,
  joinMic,
  ownSaving,
  tookPart,
  uploadInFlight,
} from "./guestRoomModel";
import { guestTabTitle } from "./guestTabTitle";
import { liveTakeOpen, NOTES_CLOSED_REASON } from "./liveCommentQueue";
import {
  copyForMicStatus,
  MIC_SAVED_DEVICE_MISSING_COPY,
} from "./micPermission";
import { noteItems } from "./noteItems";
import { roomPeople } from "./roomPeople";
import { roomToneCapturingAlert } from "./roomTone";
import { SaveAnnouncer } from "./SaveAnnouncer";
import { ownSaveLines } from "./saveStatus";
import { useStorageHeadroom } from "./storageQuota";
import {
  HEARING_COPY,
  LOCAL_KEEPER_COPY,
  LOCAL_KEEPER_PENDING_COPY,
  resolveCaptureHealth,
} from "./types";
import { useGuestRoom } from "./useGuestRoom";
import { useGuestRoomTone } from "./useGuestRoomTone";
import { useInputPeakDb } from "./useInputPeakDb";
import { useLateRoomTone } from "./useLateRoomTone";
import { useMutedSpeech } from "./useMutedSpeech";
import { recordSyncErrorCopy } from "./useRecordSync";
import { useRoomToneAnnouncement } from "./useRoomToneAnnouncement";
import { useRosterAnnouncer } from "./useRosterAnnouncer";

const subscribeLandscape = mediaQuerySubscription(["(orientation: landscape)"]);
const readLandscape = () => matchesMedia("(orientation: landscape)");
const notLandscape = () => false;

const SPEAKING_FRACTION = 0.2;

/**
 * The guest and producer room: the shared room view with the Join sheet over
 * it until the person joins. A Cover replaces the room for terminal states,
 * but every hook stays here, so the keeper and the upload outlive a Cover.
 * Try again on a full room remounts the session.
 */
export function GuestRoomApp({ token }: { token: string }) {
  const [attempt, setAttempt] = useState(0);
  const cameOnline = useRef(false);
  useEffect(() => {
    const mark = () => {
      cameOnline.current = true;
    };
    window.addEventListener("online", mark);
    return () => window.removeEventListener("online", mark);
  }, []);
  const onRetry = useCallback(() => {
    cameOnline.current = false;
    setAttempt((n) => n + 1);
  }, []);
  const onlineMissed = useCallback(() => cameOnline.current, []);
  return (
    <GuestRoomSession
      key={attempt}
      token={token}
      retried={attempt > 0}
      onRetry={onRetry}
      onlineMissed={onlineMissed}
    />
  );
}

function GuestRoomSession({
  token,
  retried,
  onRetry,
  onlineMissed,
}: {
  token: string;
  retried: boolean;
  onRetry: () => void;
  onlineMissed: () => boolean;
}) {
  const [rejoinOpen, setRejoinOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [producerDismissed, setProducerDismissed] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const room = useGuestRoom(token, { rejoining: rejoinOpen });
  const {
    bootstrap,
    producer,
    episodeName,
    snapshot,
    me,
    send,
    connected,
    error,
    clearError,
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
    roomTone,
    liveComments,
    name,
    setName,
    shareName,
    headphonesOk,
    setHeadphonesOk,
    deviceId,
    setDeviceId,
    producerJoined,
    setProducerJoined,
    resumeUpload,
  } = room;

  const shell = useViewportClass();
  const landscape = useMediaQueryStore(
    subscribeLandscape,
    readLandscape,
    notLandscape,
  );
  const viewerWidth = guestViewerWidth(shell, landscape);
  const slow = useAfter(bootstrap ? null : SKELETON_RETRY_MS);
  const state = snapshot?.state;
  const onAir = state === "recording" || state === "paused";
  const consented = me?.consented ?? null;
  const recorded = !producer && consented === true;
  const host = guestHostName(snapshot);

  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  useEffect(() => {
    if (snapshot) {
      setReceivedAt(performance.now());
    }
  }, [snapshot]);
  const elapsed = useElapsedSince(
    receivedAt,
    state === "recording" || state === "lobby",
  );
  const meter = useInputPeakDb(producer ? null : mic.stream);
  const lostDetail =
    mic.status === "lost" ||
    mic.status === "unavailable" ||
    mic.status === "error"
      ? (mic.error ?? copyForMicStatus(mic.status) ?? undefined)
      : undefined;
  const sheetMic = useSheetMic(
    { status: mic.status, stream: mic.stream, devices: mic.devices },
    {
      deviceId,
      stale: staleMic,
      levelDb: meter.levelDb,
      clipped: meter.clipped,
      // The keeper's Stop flush may still settle after the room is stopped; a
      // failed one stays "finalizing" until reload, so it must not hold the lock.
      inputLocked: onAir || (keeper.finalizing && keeper.error === null),
      detail: lostDetail,
    },
  );
  const level = dbToFraction(meter.levelDb, -60);
  const headroom = useStorageHeadroom();

  useGuestRoomTone({
    snapshot,
    participantId: me?.participant_id ?? null,
    consented,
    roomTone,
  });
  const lateRoomTone = useLateRoomTone({
    snapshot,
    me,
    producer,
    transport: uploadTransport,
    roomTone,
  });
  const announcement = useRosterAnnouncer(snapshot, me?.participant_id ?? null);
  const toneAnnouncement = useRoomToneAnnouncement(roomTone.status);
  const saveLines = useMemo(
    () => ownSaveLines(upload.segments),
    [upload.segments],
  );

  const clippedTakes = useMemo(
    () =>
      producer ? [] : guestTakes(snapshot, me, upload.segments, takeClippings),
    [producer, snapshot, me, upload.segments, takeClippings],
  );

  const micRef = useRef(mic);
  const meterRef = useRef(meter);
  useInsertionEffect(() => {
    micRef.current = mic;
    meterRef.current = meter;
  }, [mic, meter]);

  const [joinObservation, setJoinObservation] = useState({ consented, error });
  if (
    joinObservation.consented !== consented ||
    joinObservation.error !== error
  ) {
    setJoinObservation({ consented, error });
    if (consented !== null || error) {
      setJoining(false);
    }
    if (consented === true) {
      setRejoinOpen(false);
    }
  }

  const recovering =
    state === "stopped" &&
    (upload.pending ||
      upload.total > 0 ||
      !!upload.error ||
      upload.recoverable);
  const guestSheet =
    !producer &&
    ((consented === null && !recovering) || (rejoinOpen && consented !== true));
  const producerSheet = producer && !producerJoined && !producerDismissed;
  const sheetOpen = guestSheet || producerSheet;
  if (sheetOpen && deviceOpen) {
    setDeviceOpen(false);
  }

  const join = () => {
    meterRef.current.resume();
    if (producer) {
      setProducerJoined(true);
      return;
    }
    shareName();
    setJoining(true);
    if (send("Consent", { accepted: true }) === false) {
      setJoining(false);
    }
  };
  const decline = () => {
    if (producer) {
      setProducerDismissed(true);
      return;
    }
    setRejoinOpen(false);
    send("Consent", { accepted: false });
  };
  // The mic was released on Not now, and a stream opens only inside a click:
  // commit the reopened state first so this same click can ask for it.
  const rejoin = () => {
    flushSync(() => setRejoinOpen(true));
    micRef.current.request();
    meterRef.current.resume();
  };

  const mutedSpeech = useMutedSpeech(producer ? null : mic.stream, {
    muted: recorded && (me?.muted ?? false),
    counting: state === "recording",
    onAir,
  });
  const micNeedsAttention =
    recorded && onAir && (mic.lost || mic.stream === null);
  const captureHealth = resolveCaptureHealth(
    !!keeper.error,
    micNeedsAttention ? (mic.pending ? "pending" : "failed") : null,
    keeper.noAudio,
  );
  const clipped = takeClipping?.regions.length ?? 0;
  // A partial take's upload error only explains Finish saving; one action is enough.
  const recoverable = !producer && upload.recoverable && state === "stopped";
  const inTake = !producer && tookPart(snapshot, me);
  const phase = guestRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: elapsed,
    upload: producer ? null : upload,
    localSegments: room.localSegments,
    localUnreadable: room.localUnreadable,
    tookPart: producer ? undefined : inTake,
    connected,
  });
  const alerts = guestRoomAlerts(
    {
      state,
      captureHealth,
      keeperError: keeper.error,
      micLost: micNeedsAttention,
      sinkError: sheetOpen || producer ? null : sinkError,
      uploadError: producer || recoverable ? null : upload.error,
      savingUnverified:
        !producer &&
        state === "stopped" &&
        room.localUnreadable &&
        upload.fileAck,
      recoverable,
      monitorError: monitor.error,
      transportError: recordSyncErrorCopy(error),
      clipping: !producer && clippingGate(takeClipping?.regions ?? []),
      mutedSpeech,
      phase,
      inTake,
      micCheckFailed: keeper.micCheckFailed,
      notice: keeperActions.notice,
    },
    {
      retryMic: mic.retry,
      checkMic: keeper.checkMic,
      retryStorage,
      retryKeeper: state === "recording" ? keeper.retry : undefined,
      retryMonitor: monitor.retry,
      resumeUpload,
      recover: keeperActions.recover,
      dismiss: clearError,
    },
  ).map((alert) =>
    alert.kind === "saving-failed" && keeperActions.download
      ? { ...alert, onSecondaryAction: keeperActions.download }
      : alert,
  );
  if (lateRoomTone) {
    alerts.push(lateRoomTone);
  }
  const capturingTone = roomToneCapturingAlert({
    status: roomTone.status,
    clock: roomTone.clock,
    endEarly: roomTone.endEarly,
    cancel: roomTone.cancel,
  });
  if (capturingTone) {
    alerts.push(capturingTone);
  }
  if (keeperActions.error) {
    alerts.push({ kind: "generic", message: keeperActions.error });
  }

  const meId = me?.participant_id;
  const people = roomPeople(snapshot, {
    youId: meId,
    youLevel: level,
    youSpeaking: level > SPEAKING_FRACTION && !me?.muted,
    dropped: !connected,
    clipped,
    peerLevels: monitor.levels,
    saving:
      meId && state === "stopped" && !producer
        ? {
            [meId]: ownSaving(upload, room.localSegments, room.localUnreadable),
          }
        : undefined,
  });

  const cover = guestCoverProps(room, { onRetry, phase });
  useDocumentTitle(
    guestTabTitle({
      cover,
      bootstrapped: bootstrap !== null,
      seat: producer ? "producer" : "guest",
      stance: sheetOpen
        ? "joining"
        : consented === false ||
            (producer && producerDismissed && !producerJoined)
          ? "declined"
          : "in",
      phase,
      episode: episodeName,
    }),
  );
  if (cover) {
    return (
      <GuestCovers
        cover={cover}
        status={keeperActions.error ?? keeperActions.notice}
        onOnline={room.bootError === "network" ? onRetry : undefined}
        onlineMissed={onlineMissed}
      />
    );
  }
  if (!bootstrap) {
    return (
      <RoomView
        loading
        focusTitle={retried}
        page
        seat="guest"
        title="Recording"
        people={[]}
        phase={{ kind: "waiting" }}
        viewerWidth={viewerWidth}
        alerts={slow ? [{ kind: "connecting", onAction: onRetry }] : []}
        notes={[]}
        selfName=""
        onSendNote={() => false}
      />
    );
  }

  const declined = producer
    ? producerDismissed && !producerJoined
      ? { onJoin: () => setProducerDismissed(false) }
      : undefined
    : consented === false && !rejoinOpen
      ? { onJoin: rejoin }
      : undefined;
  const micNotes = [
    staleMic ? MIC_SAVED_DEVICE_MISSING_COPY : null,
    mic.settingsWarning,
    mic.status === "denied" ? copyForMicStatus("denied") : null,
  ].filter((note): note is string => !!note);
  const storageBlocker = !storageRequired
    ? undefined
    : sinkError
      ? { text: sinkError, action: { label: "Retry storage check" } }
      : sink === null
        ? { text: LOCAL_KEEPER_PENDING_COPY }
        : undefined;
  const micAction = (action: JoinMicAction) => {
    if (action === "allow") {
      meterRef.current.resume();
      mic.request();
    } else {
      // A blocked mic shows "How to allow" and tells the guest to
      // retry once the site is unblocked, so both ask again.
      mic.retry();
    }
  };

  return (
    <>
      <RoomView
        page
        seat={producer ? "producer" : "guest"}
        title={episodeName || "Recording"}
        people={people}
        phase={phase}
        viewerWidth={viewerWidth}
        alerts={alerts}
        notes={noteItems(snapshot)}
        selfName={me?.display_name ?? name}
        onSendNote={(note) => liveComments.postNote(note.text)}
        notesDisabledReason={
          liveTakeOpen(state) ? undefined : NOTES_CLOSED_REASON
        }
        muted={me?.muted ?? false}
        onMute={
          producer || !me
            ? undefined
            : () => send("SetMuted", { muted: !me.muted })
        }
        onComment={liveComments.postMarker}
        device={{
          uploading: uploadInFlight(
            producer ? null : upload,
            room.localSegments,
          ),
          finishing: !room.captureSettled,
          capturingTone: roomTone.status === "capturing",
        }}
        onLeave={room.leave}
        onDone={() => {
          room.leave();
          window.close();
        }}
        onSelfPress={producer || !me ? undefined : () => setDeviceOpen(true)}
        declined={declined}
        takes={
          clippedTakes.length > 0 ? (
            <TakesTray takes={clippedTakes} />
          ) : undefined
        }
      />
      {sheetOpen ? (
        <JoinSheet
          seat={producer ? "producer" : "guest"}
          here={joinHere(snapshot, me)}
          host={host}
          name={name}
          onNameChange={setName}
          mic={joinMic(sheetMic.input, sheetMic.options)}
          micNotes={micNotes}
          headphones={headphonesOk}
          onHeadphonesChange={setHeadphonesOk}
          lowStorage={headroom.status === "low"}
          blocker={storageBlocker}
          onBlockerAction={retryStorage}
          onMicAction={micAction}
          onInputChange={setDeviceId}
          joining={joining && consented !== true}
          onJoin={join}
          onDecline={decline}
        />
      ) : null}
      {deviceOpen && !sheetOpen && !producer ? (
        <DeviceSheet
          viewerWidth={viewerWidth === "desktop" ? "desktop" : "phone"}
          mic={deviceMic(sheetMic.input, sheetMic.options)}
          micNotes={micNotes}
          onMicAction={micAction}
          onInputChange={setDeviceId}
          headphones={headphonesOk}
          onHeadphonesChange={setHeadphonesOk}
          output={output}
          onOutputChange={output.onChange}
          onOutputRefresh={output.refresh}
          tone={deviceTone({
            status: roomTone.status,
            delivery: roomTone.delivery,
            error: roomTone.error,
            clock: roomTone.clock,
            micReady: !!mic.stream,
            captureReady: roomTone.captureReady,
            takeRunning: onAir,
          })}
          onRecordRoomTone={roomTone.record}
          onEndRoomToneEarly={roomTone.endEarly}
          onCancelRoomTone={roomTone.cancel}
          onClose={() => setDeviceOpen(false)}
        />
      ) : null}
      <div aria-live="polite" className="sr-only">
        {keeper.recordingLocally && !keeper.error && !keeper.noAudio ? (
          <p>{LOCAL_KEEPER_COPY}</p>
        ) : null}
        {monitor.hearing && connected ? <p>{HEARING_COPY}</p> : null}
        {keeperActions.notice ? <p>{keeperActions.notice}</p> : null}
        {announcement ? <p>{announcement}</p> : null}
        {toneAnnouncement ? (
          <p key={toneAnnouncement.seq}>{toneAnnouncement.text}</p>
        ) : null}
      </div>
      <SaveAnnouncer lines={saveLines} />
    </>
  );
}
