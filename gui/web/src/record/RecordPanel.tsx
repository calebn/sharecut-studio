import { useEffect, useId, useRef } from "react";
import { useDaw } from "../state/useDaw";
import { useHostRoomContext } from "./hostRoomContext";
import { RecordPanelView } from "./RecordPanelView";
import {
  type HostRoom,
  type HostRoomCapture,
  useHostRoom,
} from "./useHostRoom";

type Props = HostRoomCapture;

function RecordPanelBody({ room }: { room: HostRoom }) {
  const micHintId = useId();
  const blockersId = useId();
  const {
    recordPanelOpen,
    setRecordPanelOpen,
    shareDialogOpen,
    setShareDialogOpen,
  } = useDaw((s) => ({
    recordPanelOpen: s.chrome.recordPanelOpen,
    setRecordPanelOpen: s.setRecordPanelOpen,
    shareDialogOpen: s.chrome.shareDialogOpen,
    setShareDialogOpen: s.setShareDialogOpen,
  }));
  const {
    capture: cap,
    micLossNeedsAttention,
    captureUnavailable,
    noAudioNeedsAttention,
    setTransportError,
    recheck,
    state,
  } = room;
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

  const wasOpen = useRef(recordPanelOpen);
  useEffect(() => {
    if (recordPanelOpen && !wasOpen.current) {
      recheck();
    }
    wasOpen.current = recordPanelOpen;
  }, [recordPanelOpen, recheck]);

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

  useEffect(() => {
    if (!recordPanelOpen) {
      setTransportError(null);
    }
  }, [recordPanelOpen, setTransportError]);

  const jumpFor = (region: Parameters<HostRoom["jumpFor"]>[0]) => {
    const jump = room.jumpFor(region);
    if (!jump) {
      return null;
    }
    return () => {
      jump();
      setRecordPanelOpen(false);
    };
  };

  return (
    <RecordPanelView
      open={recordPanelOpen}
      onClose={() => setRecordPanelOpen(false)}
      closeDisabled={
        room.uploadBlocking || micLossNeedsAttention || captureUnavailable
      }
      snapshot={room.snapshot}
      roomLookup={room.roomLookup}
      host={room.host}
      onCommand={room.runCommand}
      onCheckAgain={recheck}
      transportBusy={room.transportBusy}
      takeControlRef={takeControlRef}
      control={room.control}
      land={room.land}
      startBlocked={room.startBlocked}
      blockers={room.blockers}
      blockersId={blockersId}
      startFixes={room.startFixes}
      doneNotice={room.doneNotice}
      capture={room.captureAttention}
      offline={room.offline}
      takeClipping={room.takeClipping}
      jumpFor={jumpFor}
      stream={cap.stream}
      storageReady={room.sink !== null}
      roomTone={room.roomTone}
      reconnectCopy={room.reconnectCopy}
      recordingLocally={cap.recordingLocally}
      keeperError={cap.keeperError}
      onRetryKeeper={cap.onRetryKeeper}
      noAudioNeedsAttention={noAudioNeedsAttention}
      micLossNeedsAttention={micLossNeedsAttention}
      micLost={cap.micLost}
      onRetryMic={cap.onRetryMic}
      onCheckMic={cap.onCheckMic}
      micCheckFailed={cap.micCheckFailed}
      hearing={cap.hearing}
      micHintId={micHintId}
      micCopy={room.micCopy}
      micPending={cap.micPending}
      micFailed={room.micFailed}
      micStatus={cap.micStatus}
      micError={cap.micError}
      sinkError={room.sinkError}
      onRetryStorage={room.retryStorage}
      monitorError={cap.monitorError}
      hydrateError={room.hydrateError}
      transportError={room.transportError}
      upload={room.upload}
      keeperActions={room.keeperActions}
      hostSegments={room.hostSegments}
      onResumeUpload={room.resumeUpload}
      hasRemovedParticipant={room.hasRemovedParticipant}
      liveComments={room.liveComments}
      onCopyLinks={() => {
        setRecordPanelOpen(false);
        setShareDialogOpen(true);
      }}
      onMuteChange={room.setMuted}
    />
  );
}

function StandaloneRecordPanel(props: Props) {
  const room = useHostRoom(props);
  return <RecordPanelBody room={room} />;
}

export function RecordPanel(props: Props) {
  const room = useHostRoomContext();
  return room ? (
    <RecordPanelBody room={room} />
  ) : (
    <StandaloneRecordPanel {...props} />
  );
}
