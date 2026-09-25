import { Button } from "../ui";
import { LiveComments } from "./LiveComments";
import { MicLossNotice } from "./MicLossNotice";
import { NoAudioNotice } from "./NoAudioNotice";
import { RecIndicator } from "./RecIndicator";
import { Roster } from "./Roster";
import {
  captureAttention,
  HEARING_COPY,
  HOST_OFFLINE_COPY,
  LOCAL_KEEPER_COPY,
  type RecordParticipant,
  type RecordSnapshot,
  resolveCaptureHealth,
  UPLOAD_STATUS_ID,
} from "./types";
import { UploadStatus } from "./UploadStatus";
import type { KeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import {
  leaveBlocked,
  type RecordUploadProgress,
} from "./upload/useRecordUpload";

type Props = {
  snapshot: RecordSnapshot;
  me: RecordParticipant | null;
  onMute: (muted: boolean) => void;
  onLeave: () => void;
  onMarker?: () => void;
  onSubmitNote?: () => void;
  note?: string;
  onNote?: (value: string) => void;
  connected?: boolean;
  recordingLocally?: boolean;
  keeperError?: string | null;
  noAudio?: boolean;
  micCheckFailed?: boolean;
  onCheckMic?: () => void;
  uploadSinkError?: string | null;
  onRetryKeeper?: () => void;
  hearing?: boolean;
  monitorError?: string | null;
  upload?: RecordUploadProgress;
  micLost?: boolean;
  micReady?: boolean;
  micPending?: boolean;
  onRetryMic?: () => void;
  onResumeUpload?: () => void;
  keeperActions?: KeeperRecoveryActions;
};

export function Room({
  snapshot,
  me,
  onMute,
  onLeave,
  onMarker,
  onSubmitNote,
  note = "",
  onNote,
  connected = true,
  recordingLocally = false,
  keeperError = null,
  noAudio = false,
  micCheckFailed = false,
  onCheckMic,
  uploadSinkError = null,
  onRetryKeeper,
  hearing = false,
  monitorError = null,
  upload,
  micLost = false,
  micReady = true,
  micPending = false,
  onRetryMic,
  onResumeUpload,
  keeperActions,
}: Props) {
  const hostOffline =
    !connected &&
    (snapshot.state === "recording" || snapshot.state === "paused");
  const leaveHeld = leaveBlocked(snapshot.state, upload);
  const micNeedsAttention =
    (snapshot.state === "recording" || snapshot.state === "paused") &&
    (micLost || !micReady);
  const { capture, noAudio: noAudioNeedsAttention } = captureAttention(
    snapshot.state,
    resolveCaptureHealth(
      !!keeperError,
      micNeedsAttention ? (micPending ? "pending" : "failed") : null,
      noAudio,
    ),
  );
  return (
    <div className="stack">
      <RecIndicator snapshot={snapshot} capture={capture} />
      <div aria-live="polite">
        {hostOffline ? (
          <p className="record-warn">{HOST_OFFLINE_COPY}</p>
        ) : null}
        {recordingLocally && !keeperError && !noAudioNeedsAttention ? (
          <p>{LOCAL_KEEPER_COPY}</p>
        ) : null}
        {micNeedsAttention ? <MicLossNotice onRetry={onRetryMic} /> : null}
        {noAudioNeedsAttention ? (
          <NoAudioNotice onCheck={onCheckMic} checkFailed={micCheckFailed} />
        ) : null}
        {hearing && !hostOffline ? <p>{HEARING_COPY}</p> : null}
        {keeperError ? (
          <>
            <p className="record-warn">
              Local recording stopped: {keeperError}
            </p>
            {onRetryKeeper ? (
              <Button
                type="button"
                onClick={onRetryKeeper}
                disabled={snapshot.state !== "recording"}
              >
                Retry local recording
              </Button>
            ) : null}
            {snapshot.state !== "recording" ? (
              <p>
                {snapshot.state === "paused"
                  ? "Ask the host to resume the take before retrying local recording."
                  : "Ask the host to start a new take before retrying local recording."}
              </p>
            ) : null}
          </>
        ) : null}
        {uploadSinkError ? (
          <p className="record-warn">{uploadSinkError}</p>
        ) : null}
        {monitorError ? <p className="record-warn">{monitorError}</p> : null}
        {upload ? (
          <UploadStatus
            progress={upload}
            stopped={snapshot.state === "stopped"}
            alive={connected}
            onResume={onResumeUpload}
            actions={keeperActions}
          />
        ) : null}
      </div>
      <Roster participants={snapshot.participants} />
      {onMarker && onSubmitNote && onNote ? (
        <LiveComments
          snapshot={snapshot}
          me={me}
          note={note}
          onNote={onNote}
          onMarker={onMarker}
          onSubmitNote={onSubmitNote}
        />
      ) : null}
      {me && me.role !== "producer" ? (
        <label className="cluster">
          <input
            type="checkbox"
            checked={me.muted}
            onChange={(e) => onMute(e.target.checked)}
          />
          Mute
        </label>
      ) : null}
      <Button
        type="button"
        onClick={onLeave}
        disabled={leaveHeld}
        aria-describedby={leaveHeld ? UPLOAD_STATUS_ID : undefined}
      >
        Leave
      </Button>
    </div>
  );
}
