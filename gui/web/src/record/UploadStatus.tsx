import type { ReactNode } from "react";
import { Button } from "../ui";
import {
  KEEPER_RECLAIM_FAILED_COPY,
  KEEPER_RECLAIM_MISMATCH_COPY,
  UPLOAD_DONE_COPY,
  UPLOAD_LAND_FAILED_COPY,
  UPLOAD_STATUS_ID,
  UPLOAD_WAITING_TO_LAND_COPY,
  uploadProgressCopy,
} from "./types";
import type { KeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

function RecoveryActions({
  onResume,
  actions,
  canRecover,
}: {
  onResume?: () => void;
  actions?: KeeperRecoveryActions;
  canRecover: boolean;
}) {
  const busy = actions?.busy === true;
  // Buttons stay focusable while busy (aria-disabled) so focus is not lost;
  // the hook ignores repeat clicks during a run.
  return (
    <span className="cluster">
      {onResume ? (
        <Button type="button" onClick={onResume}>
          Resume upload
        </Button>
      ) : null}
      {actions?.download ? (
        <Button
          type="button"
          onClick={actions.download}
          aria-disabled={busy || undefined}
        >
          Download local keeper
        </Button>
      ) : null}
      {canRecover && actions?.recover ? (
        <Button
          type="button"
          onClick={actions.recover}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
        >
          {busy ? "Recovering partial take…" : "Recover partial take"}
        </Button>
      ) : null}
    </span>
  );
}

function ActionFeedback({ actions }: { actions?: KeeperRecoveryActions }) {
  if (actions?.error) {
    return (
      <p className="record-warn" role="status">
        {actions.error}
      </p>
    );
  }
  if (actions?.notice) {
    return <p role="status">{actions.notice}</p>;
  }
  return null;
}

export function UploadStatus({
  progress,
  stopped,
  alive = true,
  onResume,
  actions,
}: {
  progress: RecordUploadProgress;
  stopped: boolean;
  alive?: boolean;
  onResume?: () => void;
  /** Keeper download / recovery; the Recover rule is owned here. */
  actions?: KeeperRecoveryActions;
}) {
  const canRecover = stopped && progress.recoverable;
  let status: ReactNode = null;
  if (progress.error) {
    status = (
      <div id={UPLOAD_STATUS_ID} className="record-warn">
        <p>{progress.error}</p>
        <RecoveryActions
          onResume={onResume}
          actions={actions}
          canRecover={canRecover}
        />
      </div>
    );
  } else if (progress.landFailed) {
    status = (
      <p id={UPLOAD_STATUS_ID} className="record-warn">
        {UPLOAD_LAND_FAILED_COPY}
      </p>
    );
  } else if (stopped && progress.landed && alive) {
    status = progress.reclaimFailed ? (
      <p id={UPLOAD_STATUS_ID} className="record-warn">
        {KEEPER_RECLAIM_FAILED_COPY}
      </p>
    ) : (
      <p id={UPLOAD_STATUS_ID}>{UPLOAD_DONE_COPY}</p>
    );
  } else if (stopped && progress.fileAck && !progress.landed) {
    status = <p id={UPLOAD_STATUS_ID}>{UPLOAD_WAITING_TO_LAND_COPY}</p>;
  } else if (
    progress.uploading ||
    (progress.pending && progress.total > 0) ||
    (stopped && !progress.fileAck)
  ) {
    status = (
      <div id={UPLOAD_STATUS_ID}>
        <p>{uploadProgressCopy(progress.acked, progress.total)}</p>
        {stopped ? (
          <RecoveryActions
            onResume={onResume}
            actions={actions}
            canRecover={canRecover}
          />
        ) : null}
      </div>
    );
  }
  return (
    <>
      {status}
      {progress.reclaimMismatch ? (
        <div className="record-warn" role="status">
          <p>{KEEPER_RECLAIM_MISMATCH_COPY}</p>
          <RecoveryActions
            onResume={onResume}
            actions={actions}
            canRecover={canRecover}
          />
        </div>
      ) : null}
      <ActionFeedback actions={actions} />
    </>
  );
}
