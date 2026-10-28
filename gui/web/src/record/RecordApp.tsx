import { BrandLockup, ErrorScreen, FocusPull, LoadingScreen } from "../ui";
import "../styles/partials/record-entry.css";
import { AccessEndedView } from "./AccessEndedView";
import { Declined } from "./Declined";
import { FullRoom } from "./FullRoom";
import { isNotFound } from "./guestRoomModel";
import { Lobby } from "./Lobby";
import { MIC_SAVED_DEVICE_MISSING_COPY } from "./micPermission";
import { RecIndicator } from "./RecIndicator";
import { RecordAlert } from "./RecordAlert";
import { Room } from "./Room";
import { UploadStatus } from "./UploadStatus";
import { useGuestRoom } from "./useGuestRoom";
import { recordSyncErrorCopy } from "./useRecordSync";

export function RecordApp({ token }: { token: string }) {
  const {
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
    takeClipping,
    keeperActions,
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
    setProducerJoined,
    resumeUpload,
  } = useGuestRoom(token);

  if (bootError) {
    return isNotFound(bootError) ? (
      <ErrorScreen
        message="This recording link is invalid or has ended."
        hint="Ask the host for a new link."
      />
    ) : (
      <ErrorScreen message={bootError} />
    );
  }
  if (accessEnded) {
    return (
      <AccessEndedView
        inviteClosed={inviteClosed}
        captureSettled={captureSettled}
        keeperActions={keeperActions}
      />
    );
  }
  if (!bootstrap) {
    return <LoadingScreen label="Loading studio…" />;
  }
  if (view === "full") {
    return <FullRoom />;
  }
  if (view === "declined") {
    return <Declined />;
  }

  const recoveringPriorTake =
    !producer && snapshot?.state === "stopped" && me?.consented !== true;

  const syncErrorCopy = recordSyncErrorCopy(error);
  const roleCopy = producer ? "You are listening only" : "You will be recorded";

  return (
    <main className="cover review-shell record-shell">
      <div className="cover-center center stack">
        <header className="stack">
          <p className="wordmark">
            <BrandLockup name="ShareCut Studio" />
          </p>
          <h1>{heading}</h1>
          {episodeName ? <p className="lede">{episodeName}</p> : null}
        </header>
        <p className="record-role">{roleCopy}</p>
        {syncErrorCopy ? (
          <RecordAlert actionLabel="Dismiss" onAction={clearError}>
            {syncErrorCopy}
          </RecordAlert>
        ) : null}
        {producer && view !== "room" ? <h2>Not recorded</h2> : null}
        <FocusPull viewKey={view}>
          {view === "room" && snapshot ? (
            <Room
              snapshot={snapshot}
              me={me}
              onMute={(muted) => send("SetMuted", { muted })}
              onLeave={() => send("Leave", {})}
              onMarker={liveComments.postMarker}
              onSubmitNote={liveComments.submitNote}
              note={liveComments.note}
              onNote={liveComments.setNote}
              connected={connected}
              recordingLocally={keeper.recordingLocally}
              keeperError={keeper.error}
              noAudio={keeper.noAudio}
              micCheckFailed={keeper.micCheckFailed}
              onCheckMic={keeper.checkMic}
              uploadSinkError={sinkError}
              onRetryKeeper={keeper.error ? keeper.retry : undefined}
              hearing={monitor.hearing}
              monitorError={monitor.error}
              upload={producer ? undefined : upload}
              micLost={mic.lost}
              micReady={producer || mic.stream !== null}
              micPending={mic.pending}
              onRetryMic={mic.retry}
              onResumeUpload={resumeUpload}
              keeperActions={keeperActions}
              stream={producer || me?.consented !== true ? null : mic.stream}
              clipping={takeClipping}
            />
          ) : (
            <div className="stack">
              {recoveringPriorTake && snapshot ? (
                <RecIndicator snapshot={snapshot} />
              ) : null}
              <Lobby
                producer={!!producer}
                name={name}
                onName={setName}
                headphonesOk={headphonesOk}
                onHeadphones={setHeadphonesOk}
                deviceId={staleMic ? "" : deviceId}
                onDeviceId={setDeviceId}
                micNotice={staleMic ? MIC_SAVED_DEVICE_MISSING_COPY : null}
                onJoinProducer={() => setProducerJoined(true)}
                onAccept={() => send("Consent", { accepted: true })}
                onDecline={() => send("Consent", { accepted: false })}
                showMic={!!me && error !== "room_full"}
                stream={mic.stream}
                devices={mic.devices}
                micError={mic.error}
                settingsWarning={mic.settingsWarning}
                permission={mic.status}
                onAllowMic={mic.request}
                onRetryMic={mic.retry}
                deviceLocked={
                  snapshot?.state === "recording" ||
                  snapshot?.state === "paused"
                }
                roomToneStatus={roomTone.status}
                roomToneDelivery={roomTone.delivery}
                roomToneError={roomTone.error}
                onRecordRoomTone={roomTone.record}
                onSkipRoomTone={roomTone.skip}
                onRetryRoomTone={roomTone.retry}
                roomToneReady={
                  !bootstrap.build.upload || (sink !== null && roomTone.ready)
                }
                roomToneCaptureReady={sink !== null && roomTone.captureReady}
                localStorageReady={!storageRequired || sink !== null}
                localStorageError={sinkError}
                onRetryStorage={retryStorage}
                showRoomTone={!!bootstrap.build.upload}
              />
              {recoveringPriorTake &&
              (upload.pending || upload.total > 0 || upload.error) ? (
                <UploadStatus
                  progress={upload}
                  stopped
                  alive={connected}
                  onResume={resumeUpload}
                  actions={keeperActions}
                />
              ) : null}
            </div>
          )}
        </FocusPull>
      </div>
    </main>
  );
}
