import { Button } from "../ui";
import { LiveComments } from "./LiveComments";
import { MicLossNotice } from "./MicLossNotice";
import { RecIndicator } from "./RecIndicator";
import { Roster } from "./Roster";
import {
  HEARING_COPY,
  HOST_OFFLINE_COPY,
  LOCAL_KEEPER_COPY,
  type RecordParticipant,
  type RecordSnapshot,
  UPLOAD_STATUS_ID,
} from "./types";
import { UploadStatus } from "./UploadStatus";
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
  hearing?: boolean;
  monitorError?: string | null;
  upload?: RecordUploadProgress;
  micLost?: boolean;
  onRetryMic?: () => void;
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
  hearing = false,
  monitorError = null,
  upload,
  micLost = false,
  onRetryMic,
}: Props) {
  const hostOffline =
    !connected &&
    (snapshot.state === "recording" || snapshot.state === "paused");
  const leaveHeld = leaveBlocked(snapshot.state, upload);
  return (
    <div className="stack">
      <RecIndicator snapshot={snapshot} />
      <div aria-live="polite">
        {hostOffline ? (
          <p className="record-warn">{HOST_OFFLINE_COPY}</p>
        ) : null}
        {recordingLocally ? <p>{LOCAL_KEEPER_COPY}</p> : null}
        {micLost ? <MicLossNotice onRetry={onRetryMic} /> : null}
        {hearing && !hostOffline ? <p>{HEARING_COPY}</p> : null}
        {keeperError ? <p className="record-warn">{keeperError}</p> : null}
        {monitorError ? <p className="record-warn">{monitorError}</p> : null}
        {upload ? (
          <UploadStatus
            progress={upload}
            stopped={snapshot.state === "stopped"}
            alive={connected}
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
