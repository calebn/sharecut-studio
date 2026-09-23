import { Button } from "../ui";
import {
  KEEPER_RECLAIM_FAILED_COPY,
  UPLOAD_DONE_COPY,
  UPLOAD_LAND_FAILED_COPY,
  UPLOAD_STATUS_ID,
  UPLOAD_WAITING_TO_LAND_COPY,
  uploadProgressCopy,
} from "./types";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

function RecoveryActions({
  onResume,
  onDownload,
}: {
  onResume?: () => void;
  onDownload?: () => void;
}) {
  return (
    <span className="cluster">
      {onResume ? (
        <Button type="button" onClick={onResume}>
          Resume upload
        </Button>
      ) : null}
      {onDownload ? (
        <Button type="button" onClick={onDownload}>
          Download local keeper
        </Button>
      ) : null}
    </span>
  );
}

export function UploadStatus({
  progress,
  stopped,
  alive = true,
  onResume,
  onDownload,
}: {
  progress: RecordUploadProgress;
  stopped: boolean;
  alive?: boolean;
  onResume?: () => void;
  onDownload?: () => void;
}) {
  if (progress.error) {
    return (
      <div id={UPLOAD_STATUS_ID} className="record-warn">
        <p>{progress.error}</p>
        <RecoveryActions onResume={onResume} onDownload={onDownload} />
      </div>
    );
  }
  if (progress.landFailed) {
    return (
      <p id={UPLOAD_STATUS_ID} className="record-warn">
        {UPLOAD_LAND_FAILED_COPY}
      </p>
    );
  }
  if (stopped && progress.landed && alive) {
    return progress.reclaimFailed ? (
      <p id={UPLOAD_STATUS_ID} className="record-warn">
        {KEEPER_RECLAIM_FAILED_COPY}
      </p>
    ) : (
      <p id={UPLOAD_STATUS_ID}>{UPLOAD_DONE_COPY}</p>
    );
  }
  if (stopped && progress.fileAck && !progress.landed) {
    return <p id={UPLOAD_STATUS_ID}>{UPLOAD_WAITING_TO_LAND_COPY}</p>;
  }
  if (
    progress.uploading ||
    (progress.pending && progress.total > 0) ||
    (stopped && !progress.fileAck)
  ) {
    return (
      <div id={UPLOAD_STATUS_ID}>
        <p>{uploadProgressCopy(progress.acked, progress.total)}</p>
        {stopped ? (
          <RecoveryActions onResume={onResume} onDownload={onDownload} />
        ) : null}
      </div>
    );
  }
  return null;
}
