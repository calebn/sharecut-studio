import {
  UPLOAD_DONE_COPY,
  UPLOAD_STATUS_ID,
  uploadProgressCopy,
} from "./types";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

export function UploadStatus({
  progress,
  stopped,
  alive = true,
}: {
  progress: RecordUploadProgress;
  stopped: boolean;
  alive?: boolean;
}) {
  if (progress.error) {
    return (
      <p id={UPLOAD_STATUS_ID} className="record-warn">
        {progress.error}
      </p>
    );
  }
  if (stopped && progress.fileAck && alive) {
    return <p id={UPLOAD_STATUS_ID}>{UPLOAD_DONE_COPY}</p>;
  }
  if (
    progress.uploading ||
    (progress.pending && progress.total > 0) ||
    (stopped && !progress.fileAck && progress.total > 0)
  ) {
    return (
      <p id={UPLOAD_STATUS_ID}>
        {uploadProgressCopy(progress.acked, progress.total)}
      </p>
    );
  }
  return null;
}
