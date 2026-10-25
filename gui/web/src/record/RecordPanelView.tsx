import type { ComponentProps, RefObject } from "react";
import { Button, Dialog } from "../ui";
import { HostUploadRoster } from "./HostUploadRoster";
import {
  type LandGate,
  START_FIX_LABEL,
  type StartBlockerItem,
  type StartFix,
  TAKE_CONTROL,
} from "./hostControls";
import { LiveComments } from "./LiveComments";
import { MicLossNotice } from "./MicLossNotice";
import { MicMeter } from "./MicMeter";
import { MIC_RETRY_LABEL, type MicPermissionStatus } from "./micPermission";
import { NoAudioNotice } from "./NoAudioNotice";
import { RecIndicator } from "./RecIndicator";
import { RoomToneCapture } from "./RoomToneCapture";
import { Roster } from "./Roster";
import { StopTakeControl } from "./StopTakeControl";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import { TakeClippingReport } from "./TakeClippingReport";
import {
  HEARING_COPY,
  LOCAL_KEEPER_COPY,
  RECORD_ROOM_RECONNECTING_COPY,
  type RecordParticipant,
  type RecordSnapshot,
} from "./types";
import { UploadStatus } from "./UploadStatus";
import type { useRecordLiveComments } from "./useRecordLiveComments";
import type { useRoomToneCapture } from "./useRoomToneCapture";

/** The one app shortcut the open room hands on: M drops a live marker. */
const RECORD_ROOM_SHORTCUTS = ["record.marker"] as const;

export type RecordRoomLookup = "checking" | "none" | "found" | "failed";

export type RecordPanelViewProps = {
  open: boolean;
  onClose: () => void;
  closeDisabled: boolean;
  snapshot: RecordSnapshot | null;
  roomLookup: RecordRoomLookup;
  host: RecordParticipant | undefined;
  onCommand: (commandId: string) => void;
  onCheckAgain: () => void;
  transportBusy: boolean;
  takeControlRef: RefObject<HTMLButtonElement | null>;
  control: (typeof TAKE_CONTROL)[keyof typeof TAKE_CONTROL] | null;
  land: LandGate | null;
  startBlocked: boolean;
  blockers: StartBlockerItem[];
  blockersId: string;
  startFixes: Record<StartFix, () => void>;
  doneNotice: string | null;
  capture: ComponentProps<typeof RecIndicator>["capture"];
  offline: boolean;
  takeClipping: ComponentProps<typeof TakeClippingReport>["report"];
  jumpFor: ComponentProps<typeof TakeClippingReport>["jumpFor"];
  stream: MediaStream | null;
  storageReady: boolean;
  roomTone: Pick<
    ReturnType<typeof useRoomToneCapture>,
    | "status"
    | "delivery"
    | "error"
    | "captureReady"
    | "record"
    | "skip"
    | "retry"
  >;
  reconnectCopy: string | null;
  recordingLocally: boolean;
  keeperError: string | null;
  onRetryKeeper?: () => void;
  noAudioNeedsAttention: boolean;
  micLossNeedsAttention: boolean;
  micLost: boolean;
  onRetryMic?: () => void;
  onCheckMic?: () => void;
  micCheckFailed: boolean;
  hearing: boolean;
  micHintId: string;
  micCopy: string | null;
  micPending: boolean;
  micFailed: boolean;
  micStatus: MicPermissionStatus | null;
  micError: string | null;
  sinkError: string | null;
  onRetryStorage: () => void;
  monitorError: string | null;
  hydrateError: string | null;
  transportError: string | null;
  upload: ComponentProps<typeof UploadStatus>["progress"];
  keeperActions: ComponentProps<typeof UploadStatus>["actions"];
  hostSegments: ComponentProps<typeof HostUploadRoster>["segments"];
  onResumeUpload: () => void;
  hasRemovedParticipant: boolean;
  liveComments: Pick<
    ReturnType<typeof useRecordLiveComments>,
    "note" | "setNote" | "postMarker" | "submitNote"
  >;
  onCopyLinks: () => void;
  onMuteChange: (muted: boolean) => void;
};

export function RecordPanelView({
  open,
  onClose,
  closeDisabled,
  snapshot,
  roomLookup,
  host,
  onCommand,
  onCheckAgain,
  transportBusy,
  takeControlRef,
  control,
  land,
  startBlocked,
  blockers,
  blockersId,
  startFixes,
  doneNotice,
  capture,
  offline,
  takeClipping,
  jumpFor,
  stream,
  storageReady,
  roomTone,
  reconnectCopy,
  recordingLocally,
  keeperError,
  onRetryKeeper,
  noAudioNeedsAttention,
  micLossNeedsAttention,
  micLost,
  onRetryMic,
  onCheckMic,
  micCheckFailed,
  hearing,
  micHintId,
  micCopy,
  micPending,
  micFailed,
  micStatus,
  micError,
  sinkError,
  onRetryStorage,
  monitorError,
  hydrateError,
  transportError,
  upload,
  keeperActions,
  hostSegments,
  onResumeUpload,
  hasRemovedParticipant,
  liveComments,
  onCopyLinks,
  onMuteChange,
}: RecordPanelViewProps) {
  const state = snapshot?.state;
  const recording = state === "recording";
  const paused = state === "paused";
  const takeActions =
    snapshot && control ? (
      <div className="cluster">
        <Button
          ref={takeControlRef}
          variant={control.commandId === "record.pause" ? "default" : "primary"}
          disabledReason={
            startBlocked
              ? "Resolve the items listed above to start."
              : undefined
          }
          aria-disabled={transportBusy || undefined}
          aria-describedby={startBlocked ? blockersId : undefined}
          onClick={() => onCommand(control.commandId)}
        >
          {control.label}
        </Button>
        {land ? (
          <Button
            disabledReason={land.enabled ? undefined : land.reason}
            aria-disabled={transportBusy || undefined}
            onClick={() => onCommand("record.land")}
          >
            {land.label}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record room"
      footer={takeActions}
      shortcuts={RECORD_ROOM_SHORTCUTS}
      closeDisabled={closeDisabled}
    >
      <div className="stack record-panel">
        {!snapshot && roomLookup === "none" ? (
          <div className="stack record-empty">
            <p>
              No record room yet. Creating one copies a guest link you can send.
            </p>
            <div className="cluster">
              <Button
                variant="primary"
                aria-disabled={transportBusy || undefined}
                onClick={() => onCommand("record.createRoom")}
              >
                Create record room
              </Button>
            </div>
          </div>
        ) : null}
        {!snapshot && roomLookup === "failed" ? (
          <div className="cluster record-empty">
            <Button
              aria-disabled={transportBusy || undefined}
              onClick={onCheckAgain}
            >
              Check again
            </Button>
          </div>
        ) : null}
        {!snapshot && roomLookup === "checking" ? (
          <p role="status">Looking for a record room…</p>
        ) : null}
        {snapshot ? (
          <RecIndicator
            snapshot={snapshot}
            capture={capture}
            offline={offline}
            clipping={(takeClipping?.regions.length ?? 0) > 0}
          />
        ) : null}
        {offline ? (
          <p className="record-warn" role="status">
            {RECORD_ROOM_RECONNECTING_COPY}
          </p>
        ) : null}
        {snapshot ? <MicMeter stream={stream} label="Your mic level" /> : null}
        <StorageHeadroomWarning
          visible={state === "lobby" || state === "stopped"}
          recheck={state === "stopped"}
        />
        {snapshot &&
        (snapshot.state === "lobby" || snapshot.state === "stopped") ? (
          <RoomToneCapture
            status={roomTone.status}
            delivery={roomTone.delivery}
            error={roomTone.error}
            micReady={!!stream}
            captureReady={storageReady && roomTone.captureReady}
            onRecord={roomTone.record}
            onSkip={roomTone.skip}
            onRetry={roomTone.retry}
            primary={false}
          />
        ) : null}
        <div aria-live="polite">
          {reconnectCopy ? (
            <p className="record-warn">{reconnectCopy}</p>
          ) : null}
          {recordingLocally && !keeperError && !noAudioNeedsAttention ? (
            <p>{LOCAL_KEEPER_COPY}</p>
          ) : null}
          {micLossNeedsAttention ? (
            <MicLossNotice onRetry={onRetryMic} />
          ) : null}
          {noAudioNeedsAttention ? (
            <NoAudioNotice onCheck={onCheckMic} checkFailed={micCheckFailed} />
          ) : null}
          {hearing ? <p>{HEARING_COPY}</p> : null}
          {micCopy ? (
            <p
              id={micHintId}
              role={micPending ? "status" : undefined}
              className={micFailed ? "record-warn" : undefined}
            >
              {micCopy}
            </p>
          ) : null}
          {micError && micStatus === "error" ? (
            <p className="record-warn">{micError}</p>
          ) : null}
          {micFailed && onRetryMic && !micLost ? (
            <Button
              type="button"
              onClick={onRetryMic}
              aria-describedby={micHintId}
            >
              {MIC_RETRY_LABEL}
            </Button>
          ) : null}
          {snapshot ? (
            <TakeClippingReport
              report={takeClipping}
              roomState={snapshot.state}
              jumpFor={jumpFor}
            />
          ) : null}
          {keeperError ? (
            <>
              <p className="record-warn">
                Full-quality recording stopped: {keeperError}
              </p>
              {onRetryKeeper ? (
                <Button
                  type="button"
                  onClick={onRetryKeeper}
                  disabledReason={
                    recording
                      ? undefined
                      : paused
                        ? "Resume the take to retry full-quality recording."
                        : "Start a new take to retry full-quality recording."
                  }
                >
                  Retry full-quality recording
                </Button>
              ) : null}
              {!recording ? (
                <p>
                  {paused
                    ? "Resume the take before retrying full-quality recording."
                    : "Start a new take before retrying full-quality recording."}
                </p>
              ) : null}
            </>
          ) : null}
          {sinkError && control?.stop ? (
            <>
              <p className="record-warn">{sinkError}</p>
              <Button type="button" onClick={onRetryStorage}>
                Retry storage check
              </Button>
            </>
          ) : null}
          {monitorError ? <p className="record-warn">{monitorError}</p> : null}
          {hydrateError ? <p className="record-warn">{hydrateError}</p> : null}
          {transportError ? (
            <p className="record-warn">{transportError}</p>
          ) : null}
        </div>
        <UploadStatus
          progress={upload}
          stopped={state === "stopped"}
          segmentList={false}
          onResume={onResumeUpload}
          actions={keeperActions}
        />
        {snapshot ? (
          <HostUploadRoster
            participants={snapshot.participants}
            segments={hostSegments}
            stopped={state === "stopped"}
          />
        ) : null}
        {snapshot ? (
          hasRemovedParticipant ? (
            <p className="record-warn">
              A removed participant’s invite is closed to new participants. Use
              Copy links… to replace that role’s link; existing recording access
              remains available to participants who still hold a valid lease.
            </p>
          ) : null
        ) : null}
        {snapshot ? <Roster participants={snapshot.participants} /> : null}
        {snapshot ? (
          <LiveComments
            snapshot={snapshot}
            me={host ?? null}
            note={liveComments.note}
            onNote={liveComments.setNote}
            onMarker={liveComments.postMarker}
            onSubmitNote={liveComments.submitNote}
          />
        ) : null}
        {snapshot ? (
          <div className="cluster">
            <Button onClick={onCopyLinks}>Copy links…</Button>
          </div>
        ) : null}
        {snapshot && control ? (
          <section className="stack record-controls" aria-label="Take controls">
            {host ? (
              <label className="cluster record-mute">
                <input
                  type="checkbox"
                  checked={host.muted}
                  onChange={(e) => onMuteChange(e.target.checked)}
                />
                Mute my mic
              </label>
            ) : null}
            {startBlocked ? (
              <ul id={blockersId} className="record-blockers">
                {blockers.map((item) => (
                  <li key={item.key}>
                    <span>{item.text}</span>
                    {item.fix ? (
                      <Button
                        aria-disabled={transportBusy || undefined}
                        onClick={startFixes[item.fix]}
                      >
                        {START_FIX_LABEL[item.fix]}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {doneNotice ? <p className="record-hint">{doneNotice}</p> : null}
            {land && !land.enabled ? (
              <p className="record-hint">{land.reason}</p>
            ) : null}
            {control.stop ? (
              <StopTakeControl
                busy={transportBusy}
                onStop={() => onCommand("record.stop")}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
