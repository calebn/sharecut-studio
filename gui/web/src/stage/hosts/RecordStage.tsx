import { memo, useEffect, useMemo, useRef, useState } from "react";
import { addTrackCommand, setRecordSessionNameCommand } from "../../api";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { askConfirm } from "../../feedback/ask";
import { useElapsedSince } from "../../hooks/useElapsedSince";
import { useViewportClass } from "../../hooks/useViewportClass";
import { slugText, uniqueTrackId } from "../../ingest/ingestFiles";
import {
  clippingFromRows,
  clippingGate,
  copyForMicStatus,
  deviceMic,
  deviceTone,
  END_SESSION_PENDING_COPY,
  HEARING_COPY,
  type HostRoom,
  hostMicStatus,
  hostRoomPhase,
  LOCAL_KEEPER_COPY,
  liveTakeOpen,
  MIC_RETRY_LABEL,
  MIC_SAVED_DEVICE_MISSING_COPY,
  NOTES_CLOSED_REASON,
  noteItems,
  RECORD_ROOM_RECONNECTING_COPY,
  roomAlerts,
  roomPeople,
  type SessionTarget,
  StorageHeadroomWarning,
  sendRecordHostCommand,
  takeInputs,
  useHostRoomContext,
  useInputPeakDb,
  useLastEndedSession,
  useMutedSpeech,
  useOpenSessionName,
  useRecordHostStore,
  useRoomToneAnnouncement,
  useSheetMic,
} from "../../record";
import { sessionItemId } from "../../review/reviewItems";
import { useDawStore } from "../../state/dawStore";
import { setRoomKeys } from "../../state/roomKeys";
import { DeviceSheet } from "../../system/DeviceSheet";
import { STOP_DETAIL, STOP_TITLE } from "../../system/RecordButton";
import type { RoomViewProps } from "../../system/RoomView";
import { TakesTray } from "../../system/TakesTray";
import { Toast } from "../../ui";
import { dbToFraction } from "../../ui/metering";
import { takeAutoRoom } from "../../utils/openIntent";
import { hostStateOf, type LoadFailure } from "./hostModels";
import { RecordMoreSheet } from "./RecordMoreSheet";
import {
  type RecordLookup,
  type RecordNotice,
  RecordStageView,
} from "./RecordStageView";
import { RecordTargetChip } from "./RecordTargetChip";
import {
  movableParticipants,
  remapMoves,
  sessionClipSignature,
  sessionHandoff,
} from "./recordRemapModel";
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

/** The pending end clears itself (Undo, or the window running out); the toast just follows it. */
function keepEndToast() {}

function RecordStageBody({
  room,
  loadFailure,
}: RecordStageProps & { room: HostRoom }) {
  const project = useDawStore((s) => s.project);
  const projectPath = useDawStore((s) => s.projectPath);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const receivedAtMs = useRecordHostStore((s) => s.receivedAtMs);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const toneAnnouncement = useRoomToneAnnouncement(room.roomTone.status);
  const endPending = room.endSession.ending;
  useEffect(() => {
    if (endPending) announceStatus(END_SESSION_PENDING_COPY, { toast: false });
  }, [endPending, announceStatus]);
  useEffect(() => {
    if (toneAnnouncement) {
      announceStatus(toneAnnouncement.text);
    }
  }, [toneAnnouncement, announceStatus]);
  const shell = useViewportClass();
  const [moreOpen, setMoreOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const { snapshot, state, host, capture: cap } = room;
  const lookup = lookupOf(room);
  const autoRoomChecked = useRef(false);
  useEffect(() => {
    if (autoRoomChecked.current || !projectPath || lookup === "checking") {
      return;
    }
    autoRoomChecked.current = true;
    // Home's Record sends the host here to make the first room: create it and
    // open Invite so the link is one tap away (INT-REC-OPEN).
    if (!takeAutoRoom(projectPath) || lookup !== "none") {
      return;
    }
    void executePointerCommand("record.createRoom").then((result) => {
      if (result.status === "ok") {
        runPointerCommand("share.manage", { at: "record" });
      }
    });
  }, [lookup, projectPath]);
  const { session: lastSession, refresh: refreshLastSession } =
    useLastEndedSession(projectPath, lookup === "none");
  const sessionName = useOpenSessionName(
    projectPath,
    snapshot?.session_id ?? null,
    snapshot?.state,
  );
  const [remapBusy, setRemapBusy] = useState(false);
  const clipTracks = project?.clips.tracks;
  const projectTracks = useMemo(
    () => (project?.tracks ?? []).map((t) => ({ id: t.id, label: t.label })),
    [project?.tracks],
  );
  const movable = useMemo(
    () =>
      lastSession?.landed
        ? movableParticipants(
            clipTracks,
            lastSession.session_id,
            lastSession.participants.map((p) => p.participant_id),
          )
        : undefined,
    [clipTracks, lastSession],
  );
  // Any move of the session's clips (the card's own, Undo, Redo, another editor)
  // re-reads the card; the first signature seen for a session is only recorded.
  const shownId = lastSession?.session_id ?? null;
  // The history head moves with every undo, redo and edit, so a rename that is
  // undone or redone (the name is not in the client project) re-reads the card too.
  const historyHead = project?.history?.head_id ?? null;
  const signature = shownId
    ? `${sessionClipSignature(clipTracks, shownId)}|${historyHead}`
    : null;
  const seen = useRef<{ id: string | null; signature: string | null }>({
    id: null,
    signature: null,
  });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { id: shownId, signature };
    if (shownId && prev.id === shownId && prev.signature !== signature) {
      refreshLastSession();
    }
  }, [shownId, signature, refreshLastSession]);
  const handoff = useMemo(
    () =>
      lastSession?.landed
        ? sessionHandoff(clipTracks, lastSession.session_id)
        : null,
    [clipTracks, lastSession],
  );
  const failRemap = (why: string) =>
    announceStatus(`Could not change the track: ${why}`, { tone: "error" });
  const moveTo = async (participantId: string, trackId: string) => {
    if (!lastSession) {
      return;
    }
    const clips = remapMoves(
      clipTracks,
      lastSession.session_id,
      participantId,
      trackId,
    );
    if (clips.length === 0) {
      return;
    }
    const result = await executePointerCommand("edit.moveClips", { clips });
    if (result.status !== "ok") {
      failRemap(result.status === "disabled" ? result.reason : "try again");
    }
  };
  const remap = async (participantId: string, trackId: string) => {
    if (remapBusy) {
      return;
    }
    setRemapBusy(true);
    try {
      await moveTo(participantId, trackId);
    } finally {
      setRemapBusy(false);
    }
  };
  // The track is made first and stays, empty, if the move then fails.
  const newTrack = async (participantId: string) => {
    const person = lastSession?.participants.find(
      (p) => p.participant_id === participantId,
    );
    if (!lastSession || !person || remapBusy) {
      return;
    }
    if (
      remapMoves(clipTracks, lastSession.session_id, participantId, "")
        .length === 0
    ) {
      return;
    }
    setRemapBusy(true);
    try {
      const name = person.display_name.trim() || "Guest";
      const trackId = uniqueTrackId(
        slugText(name),
        new Set((project?.tracks ?? []).map((t) => t.id)),
      );
      await addTrackCommand(projectPath, {
        track_id: trackId,
        label: name,
        speaker: name,
      });
      await moveTo(participantId, trackId);
    } catch (e) {
      failRemap(e instanceof Error ? e.message : "try again");
    } finally {
      setRemapBusy(false);
    }
  };
  const rename = async (name: string) => {
    if (!lastSession || remapBusy) {
      return;
    }
    setRemapBusy(true);
    try {
      await setRecordSessionNameCommand(
        projectPath,
        lastSession.session_id,
        name,
      );
      refreshLastSession();
    } catch (e) {
      announceStatus(
        `Could not rename the session: ${e instanceof Error ? e.message : "try again"}`,
        { tone: "error" },
      );
    } finally {
      setRemapBusy(false);
    }
  };
  const editSession = async () => {
    if (!handoff) {
      return;
    }
    const opened = await executePointerCommand("stage.edit");
    if (opened.status !== "ok") {
      return;
    }
    await executePointerCommand("transport.seek", { sec: handoff.startSec });
    useDawStore.getState().setSelection({
      kind: "clip",
      id: handoff.primary.id,
      trackId: handoff.primary.trackId,
      ids: handoff.clipIds,
    });
  };
  const pickup = useMemo(
    () =>
      lastSession
        ? ((project?.session_suggestions ?? []).find(
            (s) => s.session_id === lastSession.session_id,
          ) ?? null)
        : null,
    [lastSession, project?.session_suggestions],
  );
  const reviewPickup = async (suggestionId: string) => {
    useDawStore.getState().setPendingReviewItem(sessionItemId(suggestionId));
    const opened = await executePointerCommand("stage.review", {
      section: "queue",
    });
    if (opened.status !== "ok") {
      useDawStore.getState().setPendingReviewItem(null);
    }
  };
  const trackNames = useMemo(
    () => new Map((project?.tracks ?? []).map((t) => [t.id, t.label])),
    [project?.tracks],
  );
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
  const peerLevels = useRecordHostStore((s) => s.peerLevels);
  const peerClipped = useMemo(() => {
    const counts: Record<string, number> = {};
    const rows = room.hostSegments ?? [];
    if (!snapshot || rows.length === 0) return counts;
    for (const person of snapshot.participants) {
      if (person.participant_id === host?.participant_id) continue;
      const found = clippingFromRows(
        rows,
        snapshot.take_index,
        person.participant_id,
      );
      if (found) counts[person.participant_id] = found.regions.length;
    }
    return counts;
  }, [room.hostSegments, snapshot, host?.participant_id]);
  const people = roomPeople(snapshot, {
    youLevel: level,
    youSpeaking: level > SPEAKING_FRACTION && !host?.muted,
    dropped: room.offline,
    clipped: room.takeClipping?.regions.length ?? 0,
    peerLevels,
    peerClipped,
  });
  const mutedSpeech = useMutedSpeech(cap.stream ?? null, {
    muted: host?.muted ?? false,
    counting: state === "recording",
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
      clipping: clippingGate(room.takeClipping?.regions ?? []),
      mutedSpeech,
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
  const keyProps = snapshot
    ? {
        take: live || paused ? ("live" as const) : ("idle" as const),
        start:
          canRecord && !startDisabledReason(room.startBlocked, room.blockers)
            ? () => room.runCommand("record.start")
            : undefined,
        stop: canRecord ? () => room.runCommand("record.stop") : undefined,
        pause: () => room.runCommand(paused ? "record.resume" : "record.pause"),
        mute: host ? () => room.setMuted(!host.muted) : undefined,
      }
    : null;
  const keyStart = keyProps?.start;
  const keyStop = keyProps?.stop;
  const keyMute = keyProps?.mute;
  const keyTake = keyProps?.take;
  const keyPause = keyProps?.pause;
  useEffect(() => {
    if (!keyTake) return;
    setRoomKeys({
      take: keyTake,
      start: keyStart,
      stop: keyStop,
      pause: keyPause,
      mute: keyMute,
    });
    return () => setRoomKeys(null);
  }, [keyTake, keyStart, keyStop, keyPause, keyMute]);

  const roomProps: RoomViewProps | null = snapshot
    ? {
        seat: "host",
        title: project?.meta.name ?? "",
        sessionName: sessionName ?? undefined,
        people,
        phase,
        viewerWidth: viewerWidthOf(shell),
        alerts,
        defaultNotesOpen: true,
        notes: noteItems(snapshot),
        noteVisibility: false,
        notesDisabledReason: liveTakeOpen(state)
          ? undefined
          : NOTES_CLOSED_REASON,
        selfName: host?.display_name ?? "Host",
        onSendNote: (note) => room.liveComments.postNote(note.text),
        onInvite: () => runPointerCommand("share.manage", { at: "record" }),
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
        onStopPaused: canRecord
          ? () => {
              void askConfirm({
                title: STOP_TITLE,
                message: STOP_DETAIL,
                keepLabel: "Keep recording",
                actionLabel: "Stop take",
                danger: true,
              }).then((stop) => {
                if (stop) room.runCommand("record.stop");
              });
            }
          : undefined,
        onMore: () => setMoreOpen(true),
        onSelfPress: () => setDeviceOpen(true),
        onRemovePerson: canRecord
          ? (id: string, name: string) => {
              void askConfirm({
                title: `Remove ${name} from the room?`,
                message:
                  "They leave the room and their link stops working. Anything they have not finished uploading will not reach the project.",
                keepLabel: "Keep in room",
                actionLabel: "Remove",
                danger: true,
              }).then((remove) => {
                if (remove)
                  void sendRecordHostCommand("RemoveParticipant", {
                    participant_id: id,
                  });
              });
            }
          : undefined,
        takes,
        target: targetChip,
      }
    : null;

  // Failures live in the Alert slot (roomAlerts); the two always-on lines
  // are for screen readers only, as on the guest page.
  const srNotes: string[] = [];
  if (cap.recordingLocally && !cap.keeperError && !room.noAudioNeedsAttention) {
    srNotes.push(LOCAL_KEEPER_COPY);
  }
  if (cap.hearing) {
    srNotes.push(HEARING_COPY);
  }
  const notices: RecordNotice[] = [];
  const note = (text: string) => notices.push({ text });
  if (room.offline) {
    note(RECORD_ROOM_RECONNECTING_COPY);
  }
  if (room.reconnectCopy) {
    note(room.reconnectCopy);
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
  if (room.doneNotice) {
    note(room.doneNotice);
  }

  const toneAvailable = state === "lobby" || state === "stopped";
  const more = snapshot ? (
    <RecordMoreSheet
      open={moreOpen}
      onClose={() => setMoreOpen(false)}
      busy={room.transportBusy}
      upload={room.upload}
      keeperActions={room.keeperActions}
      stopped={state === "stopped"}
      onResumeUpload={room.resumeUpload}
      removedInvite={room.hasRemovedParticipant}
      onInvite={() => {
        setMoreOpen(false);
        runPointerCommand("share.manage", { at: "record" });
      }}
      guestsSeeNotes={snapshot.guests_see_notes === true}
      onGuestsSeeNotesChange={room.setGuestsSeeNotes}
      guestsSeeNotesError={room.guestsSeeNotesError}
      micOn={room.micOn}
      onMicChange={room.setMicOn}
      micReason={
        state === "recording" || state === "paused"
          ? "Stop the take to change this."
          : undefined
      }
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
        output={cap.output}
        onOutputChange={cap.output.onChange}
        onOutputRefresh={cap.output.refresh}
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
      lookup={lookup}
      busy={room.transportBusy}
      hydrateError={room.hydrateError}
      transportError={room.transportError}
      room={roomProps}
      lastSession={lastSession}
      trackNames={trackNames}
      tracks={projectTracks}
      movable={movable}
      remapBusy={remapBusy}
      onRemap={(participantId, trackId) => void remap(participantId, trackId)}
      onNewTrack={(participantId) => void newTrack(participantId)}
      onEdit={() => void editSession()}
      onReviewPickup={pickup ? () => void reviewPickup(pickup.id) : undefined}
      onRename={(name) => void rename(name)}
      hasClips={handoff !== null}
      storage={
        <StorageHeadroomWarning
          visible={state === "lobby" || state === "stopped"}
          recheck={state === "stopped"}
        />
      }
      notices={notices}
      srNotes={srNotes}
      toast={
        <Toast
          className="sys-toast-dock"
          toast={
            room.endSession.ending
              ? { id: 1, message: END_SESSION_PENDING_COPY }
              : null
          }
          onUndo={room.endSession.undo}
          onDismiss={keepEndToast}
        />
      }
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

function RecordStageAdapter(props: RecordStageProps) {
  const room = useHostRoomContext();
  if (!room) {
    throw new Error("RecordStage needs a HostRoomProvider above it");
  }
  return <RecordStageBody room={room} {...props} />;
}

export const RecordStage = memo(RecordStageAdapter);
