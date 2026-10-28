import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useElapsedSince } from "../hooks/useElapsedSince";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import { useViewportClass } from "../hooks/useViewportClass";
import { JoinSheet } from "../system/JoinSheet";
import { RoomView } from "../system/RoomView";
import { LoadingScreen } from "../ui";
import { dbToFraction } from "../ui/metering";
import { GuestCovers } from "./GuestCovers";
import {
  guestCoverProps,
  guestHostName,
  guestRoomAlerts,
  guestRoomPhase,
  guestViewerWidth,
  joinHere,
  joinMic,
  ownSaving,
  savingStatus,
  tookPart,
} from "./guestRoomModel";
import { liveTakeOpen } from "./liveCommentQueue";
import {
  copyForMicStatus,
  MIC_SAVED_DEVICE_MISSING_COPY,
} from "./micPermission";
import { noteItems } from "./noteItems";
import { roomPeople } from "./roomPeople";
import { SaveAnnouncer } from "./SaveAnnouncer";
import { ownSaveLines } from "./saveStatus";
import { useStorageHeadroom } from "./storageQuota";
import {
  HEARING_COPY,
  LOCAL_KEEPER_COPY,
  LOCAL_KEEPER_PENDING_COPY,
  resolveCaptureHealth,
} from "./types";
import { leaveBlocked } from "./upload/useRecordUpload";
import { useGuestRoom } from "./useGuestRoom";
import { useGuestRoomTone } from "./useGuestRoomTone";
import { useInputPeakDb } from "./useInputPeakDb";
import { useLateRoomTone } from "./useLateRoomTone";
import { recordSyncErrorCopy } from "./useRecordSync";
import { useRosterAnnouncer } from "./useRosterAnnouncer";

const subscribeLandscape = mediaQuerySubscription(["(orientation: landscape)"]);
const readLandscape = () => matchesMedia("(orientation: landscape)");
const notLandscape = () => false;

const NOTES_CLOSED_REASON = "Notes open while a take is running.";
const LEAVE_HELD_REASON = "Keep this tab open until your recording is saved.";
const SPEAKING_FRACTION = 0.2;

/**
 * The guest and producer room: the shared room view with the Join sheet over
 * it until the person joins. A Cover replaces the room for terminal states,
 * but every hook stays here, so the keeper and the upload outlive a Cover.
 * Try again on a full room remounts the session.
 */
export function GuestRoomApp({ token }: { token: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <GuestRoomSession
      key={attempt}
      token={token}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

function GuestRoomSession({
  token,
  onRetry,
}: {
  token: string;
  onRetry: () => void;
}) {
  const [rejoinOpen, setRejoinOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [producerDismissed, setProducerDismissed] = useState(false);
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
    upload,
    uploadTransport,
    takeClipping,
    keeperActions,
    roomTone,
    liveComments,
    name,
    setName,
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
  const saveLines = useMemo(
    () => ownSaveLines(upload.segments),
    [upload.segments],
  );

  const micRef = useRef(mic);
  micRef.current = mic;
  const meterRef = useRef(meter);
  meterRef.current = meter;

  useEffect(() => {
    if (consented !== null || error) {
      setJoining(false);
    }
    if (consented === true) {
      setRejoinOpen(false);
    }
  }, [consented, error]);

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

  const join = () => {
    meterRef.current.resume();
    if (producer) {
      setProducerJoined(true);
      return;
    }
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

  const dropped = !connected && onAir && recorded;
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
  const alerts = guestRoomAlerts(
    {
      state,
      captureHealth,
      keeperError: keeper.error,
      micLost: micNeedsAttention,
      sinkError: sheetOpen || producer ? null : sinkError,
      uploadError: producer || recoverable ? null : upload.error,
      recoverable,
      monitorError: monitor.error,
      transportError: recordSyncErrorCopy(error),
      clipped: producer ? 0 : clipped,
      muted: recorded && (me?.muted ?? false),
      dropped,
      micCheckFailed: keeper.micCheckFailed,
      notice: keeperActions.notice,
    },
    {
      retryMic: mic.retry,
      checkMic: keeper.checkMic,
      retryStorage,
      retryKeeper: state === "recording" ? keeper.retry : undefined,
      resumeUpload,
      recover: keeperActions.recover,
      dismiss: clearError,
    },
    host,
  ).map((alert) =>
    alert.kind === "saving-failed" && keeperActions.download
      ? { ...alert, onSecondaryAction: keeperActions.download }
      : alert,
  );
  if (lateRoomTone) {
    alerts.push(lateRoomTone);
  }
  if (keeperActions.error) {
    alerts.push({ kind: "generic", message: keeperActions.error });
  }

  const meId = me?.participant_id;
  const people = roomPeople(snapshot, {
    youId: meId,
    youLevel: level,
    youSpeaking: level > SPEAKING_FRACTION && !me?.muted,
    dropped,
    clipped,
    peerLevels: monitor.levels,
    saving:
      meId && state === "stopped" && !producer
        ? { [meId]: ownSaving(upload) }
        : undefined,
  });
  const phase = guestRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: elapsed,
    upload: producer ? null : upload,
    tookPart: producer ? undefined : tookPart(snapshot, me),
  });

  const cover = guestCoverProps(room, onRetry);
  if (cover) {
    return (
      <GuestCovers
        cover={cover}
        status={keeperActions.error ?? keeperActions.notice}
      />
    );
  }
  if (!bootstrap) {
    return <LoadingScreen label="Loading studio…" />;
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
  const lostDetail =
    mic.status === "lost" ||
    mic.status === "unavailable" ||
    mic.status === "error"
      ? (mic.error ?? copyForMicStatus(mic.status) ?? undefined)
      : undefined;
  const storageBlocker = !storageRequired
    ? undefined
    : sinkError
      ? { text: sinkError, action: { label: "Retry storage check" } }
      : sink === null
        ? { text: LOCAL_KEEPER_PENDING_COPY }
        : undefined;
  const heldLeave = !producer && leaveBlocked(state ?? "", upload);

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
        onLeave={() => send("Leave", {})}
        leaveDisabledReason={heldLeave ? LEAVE_HELD_REASON : undefined}
        status={producer ? undefined : (savingStatus(upload) ?? undefined)}
        declined={declined}
      />
      {sheetOpen ? (
        <JoinSheet
          seat={producer ? "producer" : "guest"}
          viewerWidth={viewerWidth === "desktop" ? "desktop" : "phone"}
          here={joinHere(snapshot, me)}
          host={host}
          name={name}
          onNameChange={setName}
          mic={joinMic(
            { status: mic.status, stream: mic.stream, devices: mic.devices },
            {
              deviceId: staleMic ? "" : deviceId,
              levelDb: meter.levelDb,
              clipped: meter.clipped,
              inputLocked: onAir,
              detail: lostDetail,
            },
          )}
          micNotes={micNotes}
          headphones={headphonesOk}
          onHeadphonesChange={setHeadphonesOk}
          lowStorage={headroom.status === "low"}
          blocker={storageBlocker}
          onBlockerAction={retryStorage}
          onMicAction={(action) => {
            if (action === "allow") {
              meterRef.current.resume();
              mic.request();
            } else {
              // A blocked mic shows "How to allow" and tells the guest to
              // retry once the site is unblocked, so both ask again.
              mic.retry();
            }
          }}
          onInputChange={setDeviceId}
          joining={joining && consented !== true}
          rejoin={rejoinOpen}
          onJoin={join}
          onDecline={decline}
        />
      ) : null}
      <div aria-live="polite" className="sr-only">
        {keeper.recordingLocally && !keeper.error && !keeper.noAudio ? (
          <p>{LOCAL_KEEPER_COPY}</p>
        ) : null}
        {monitor.hearing && !dropped ? <p>{HEARING_COPY}</p> : null}
        {keeperActions.notice ? <p>{keeperActions.notice}</p> : null}
        {announcement ? <p>{announcement}</p> : null}
      </div>
      <SaveAnnouncer lines={saveLines} />
    </>
  );
}
