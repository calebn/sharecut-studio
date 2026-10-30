import { memo, useEffect, useState } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useElapsedSince } from "../../hooks/useElapsedSince";
import { useViewportClass } from "../../hooks/useViewportClass";
import {
  copyForMicStatus,
  deviceMic,
  deviceTone,
  END_SESSION_PENDING_COPY,
  HEARING_COPY,
  type HostRoom,
  hostMicStatus,
  hostRoomPhase,
  LOCAL_KEEPER_COPY,
  MIC_RETRY_LABEL,
  MIC_SAVED_DEVICE_MISSING_COPY,
  noteItems,
  RECORD_ROOM_RECONNECTING_COPY,
  roomAlerts,
  roomPeople,
  type SessionTarget,
  StorageHeadroomWarning,
  takeInputs,
  useHostRoom,
  useHostRoomContext,
  useInputPeakDb,
  useRecordHostStore,
  useRoomToneAnnouncement,
  useSheetMic,
} from "../../record";
import { useDawStore } from "../../state/dawStore";
import { DeviceSheet } from "../../system/DeviceSheet";
import type { RoomViewProps } from "../../system/RoomView";
import { TakesTray } from "../../system/TakesTray";
import { dbToFraction } from "../../ui/metering";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { hostStateOf } from "./hostModels";
import { RecordMoreSheet } from "./RecordMoreSheet";
import {
  type RecordLookup,
  type RecordNotice,
  RecordStageView,
} from "./RecordStageView";
import { RecordTargetChip } from "./RecordTargetChip";
import {
  firstClipped,
  startDisabledReason,
  takeIndexOf,
  trayTakes,
  viewerWidthOf,
} from "./recordStageModel";
import { usePendingRecordTarget } from "./usePendingRecordTarget";

export type RecordStageProps = {
  loadFailure?: LoadFailure | null;
};

const SPEAKING_FRACTION = 0.2;
const TAKE_START = { segmentIndex: 0, segmentStartMs: 0, startMs: 0, endMs: 0 };

function lookupOf(room: HostRoom): RecordLookup {
  if (room.snapshot) {
    return "found";
  }
  return room.roomLookup;
}

function RecordStageBody({
  room,
  loadFailure,
}: RecordStageProps & { room: HostRoom }) {
  const project = useDawStore((s) => s.project);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const receivedAtMs = useRecordHostStore((s) => s.receivedAtMs);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const toneAnnouncement = useRoomToneAnnouncement(room.roomTone.status);
  useEffect(() => {
    if (toneAnnouncement) {
      announceStatus(toneAnnouncement.text);
    }
  }, [toneAnnouncement, announceStatus]);
  const shell = useViewportClass();
  const [moreOpen, setMoreOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const { snapshot, state, host, capture: cap } = room;
  const ticking = state === "recording" || state === "lobby";
  const elapsed = useElapsedSince(receivedAtMs, ticking);
  const meter = useInputPeakDb(cap.stream);
  const micStatus = hostMicStatus(cap.micStatus, cap.micLost);
  const paused = state === "paused";
  const live = state === "recording";
  const sheetMic = useSheetMic(
    { status: micStatus, stream: cap.stream, devices: cap.devices },
    {
      deviceId: cap.deviceId,
      stale: cap.staleMic,
      levelDb: meter.levelDb,
      clipped: meter.clipped,
      // The keeper's Stop flush may still settle after the room is stopped; a
      // failed one stays "finalizing" until reload, so it must not hold the lock.
      inputLocked: live || paused || (cap.keeperFinalizing && !cap.keeperError),
      detail: cap.micError ?? undefined,
    },
  );
  if (!snapshot && deviceOpen) {
    setDeviceOpen(false);
  }
  const level = dbToFraction(meter.levelDb, -60);

  const phase = hostRoomPhase(snapshot, {
    elapsedSinceSnapshotMs: elapsed,
    dropped: room.offline,
    segments: room.hostSegments,
  });
  const people = roomPeople(snapshot, {
    youLevel: level,
    youSpeaking: level > SPEAKING_FRACTION && !host?.muted,
    dropped: room.offline,
    clipped: room.takeClipping?.regions.length ?? 0,
  });
  const alerts = roomAlerts(
    {
      state,
      captureHealth,
      keeperError: cap.keeperError,
      micLost: cap.micLost,
      sinkError: room.sinkError,
      uploadError: room.upload.error,
      recoverable: room.upload.recoverable && state === "stopped",
      monitorError: cap.monitorError,
      transportError: room.transportError,
      hydrateError: room.hydrateError,
      clipped: room.takeClipping?.regions.length ?? 0,
      muted: host?.muted ?? false,
      micCheckFailed: cap.micCheckFailed,
    },
    {
      retryMic: cap.onRetryMic,
      checkMic: cap.onCheckMic,
      retryStorage: room.retryStorage,
      retryKeeper: cap.onRetryKeeper,
      resumeUpload: room.resumeUpload,
      recover: room.keeperActions.recover,
      dismiss: () => {
        room.setTransportError(null);
        if (room.hydrateError) {
          room.recheck();
        }
      },
    },
  );

  const inputs = takeInputs(snapshot, room.hostSegments, room.takeClipping);
  const hearTake = (id: string) => {
    const takeIndex = takeIndexOf(id);
    const first = firstClipped(inputs, takeIndex);
    const jump = room.jumpFor(
      first?.region ?? TAKE_START,
      takeIndex,
      first?.participantId,
    );
    if (jump) {
      runPointerCommand("stage.edit");
      jump();
    } else {
      announceStatus("That take is not on the timeline yet.");
    }
  };
  const takes = (
    <TakesTray
      takes={trayTakes(inputs, snapshot, room.hostSegments)}
      onHear={hearTake}
      onRetry={() => room.runCommand("record.land")}
    />
  );

  const setTarget = (target: SessionTarget) =>
    room.runCommand("record.setTarget", { target });
  usePendingRecordTarget(
    {
      snapshot,
      state,
      lookup: room.roomLookup,
      controlled: room.control !== null,
      busy: room.transportBusy,
    },
    setTarget,
  );
  const targetChip = snapshot ? (
    <RecordTargetChip
      snapshot={snapshot}
      busy={room.transportBusy}
      onSetTarget={setTarget}
    />
  ) : undefined;

  const canRecord = snapshot !== null && room.control !== null;
  const roomProps: RoomViewProps | null = snapshot
    ? {
        seat: "host",
        title: project?.meta.name ?? "",
        people,
        phase,
        viewerWidth: viewerWidthOf(shell),
        alerts,
        defaultNotesOpen: true,
        notes: noteItems(snapshot),
        selfName: host?.display_name ?? "Host",
        onSendNote: (note) => room.liveComments.postNote(note.text),
        onInvite: () => runPointerCommand("share.manage"),
        muted: host?.muted ?? false,
        onStartTake: canRecord
          ? () => room.runCommand(paused ? "record.resume" : "record.start")
          : undefined,
        onStopTake: canRecord
          ? () => room.runCommand("record.stop")
          : undefined,
        recordBusy: room.transportBusy,
        recordDisabledReason:
          live || paused
            ? undefined
            : startDisabledReason(room.startBlocked, room.blockers),
        onMute: host ? () => room.setMuted(!host.muted) : undefined,
        onComment: room.liveComments.postMarker,
        onPause: () =>
          room.runCommand(paused ? "record.resume" : "record.pause"),
        onMore: () => setMoreOpen(true),
        onSelfPress: () => setDeviceOpen(true),
        takes,
        target: targetChip,
      }
    : null;

  const notices: RecordNotice[] = [];
  const note = (text: string) => notices.push({ text });
  if (room.offline) {
    note(RECORD_ROOM_RECONNECTING_COPY);
  }
  if (room.reconnectCopy) {
    note(room.reconnectCopy);
  }
  if (cap.recordingLocally && !cap.keeperError && !room.noAudioNeedsAttention) {
    note(LOCAL_KEEPER_COPY);
  }
  if (cap.hearing) {
    note(HEARING_COPY);
  }
  if (cap.keeperError) {
    note(`Full-quality recording stopped: ${cap.keeperError}`);
  }
  if (room.sinkError) {
    note(room.sinkError);
  }
  if (room.upload.error) {
    note(room.upload.error);
  }
  if (room.micCopy) {
    notices.push({
      text: room.micCopy,
      action:
        room.micFailed && cap.onRetryMic && !cap.micLost
          ? { label: MIC_RETRY_LABEL, onClick: cap.onRetryMic }
          : undefined,
    });
  }
  if (cap.micError && cap.micStatus === "error") {
    note(cap.micError);
  }
  if (cap.monitorError) {
    note(cap.monitorError);
  }
  if (room.doneNotice) {
    note(room.doneNotice);
  }
  if (room.endSession.ending) {
    notices.push({
      text: END_SESSION_PENDING_COPY,
      action: { label: "Undo", onClick: room.endSession.undo },
    });
  }

  const toneAvailable = state === "lobby" || state === "stopped";
  const more = snapshot ? (
    <RecordMoreSheet
      open={moreOpen}
      onClose={() => setMoreOpen(false)}
      busy={room.transportBusy}
      land={room.land}
      onLand={() => room.runCommand("record.land")}
      canStop={room.control?.stop === true}
      onStop={() => room.runCommand("record.stop")}
      upload={room.upload}
      keeperActions={room.keeperActions}
      stopped={state === "stopped"}
      onResumeUpload={room.resumeUpload}
      removedInvite={room.hasRemovedParticipant}
      onInvite={() => {
        setMoreOpen(false);
        runPointerCommand("share.manage");
      }}
      onDevices={() => {
        setMoreOpen(false);
        setDeviceOpen(true);
      }}
      onEndSession={
        room.endSession.ending || room.endSession.busy
          ? undefined
          : room.endSession.end
      }
      endReason={
        room.endSession.gate.enabled ? undefined : room.endSession.gate.reason
      }
    />
  ) : undefined;
  const micNotes = [
    cap.staleMic ? MIC_SAVED_DEVICE_MISSING_COPY : null,
    micStatus === "denied" ? copyForMicStatus("denied") : null,
  ].filter((note): note is string => !!note);
  const devices =
    snapshot && deviceOpen ? (
      <DeviceSheet
        viewerWidth={viewerWidthOf(shell) === "desktop" ? "desktop" : "phone"}
        mic={deviceMic(sheetMic.input, sheetMic.options)}
        micNotes={micNotes}
        onMicAction={() => cap.onRetryMic?.()}
        onInputChange={cap.onDeviceChange}
        tone={deviceTone({
          status: room.roomTone.status,
          delivery: room.roomTone.delivery,
          error: room.roomTone.error,
          clock: room.roomTone.clock,
          micReady: !!cap.stream,
          captureReady: room.sink !== null && room.roomTone.captureReady,
          takeRunning: !toneAvailable,
        })}
        onRecordRoomTone={room.roomTone.record}
        onEndRoomToneEarly={room.roomTone.endEarly}
        onCancelRoomTone={room.roomTone.cancel}
        onClose={() => setDeviceOpen(false)}
      />
    ) : null;

  return (
    <RecordStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      lookup={lookupOf(room)}
      busy={room.transportBusy}
      hydrateError={room.hydrateError}
      transportError={room.transportError}
      room={roomProps}
      storage={
        <StorageHeadroomWarning
          visible={state === "lobby" || state === "stopped"}
          recheck={state === "stopped"}
        />
      }
      notices={notices}
      more={
        <>
          {more}
          {devices}
        </>
      }
      onCreateRoom={() => room.runCommand("record.createRoom")}
      onCheckAgain={room.recheck}
    />
  );
}

function StandaloneRecordStage(props: RecordStageProps) {
  const room = useHostRoom({}, { hydrate: true });
  return <RecordStageBody room={room} {...props} />;
}

function RecordStageAdapter(props: RecordStageProps) {
  const room = useHostRoomContext();
  return room ? (
    <RecordStageBody room={room} {...props} />
  ) : (
    <StandaloneRecordStage {...props} />
  );
}

export const RecordStage = memo(RecordStageAdapter);
