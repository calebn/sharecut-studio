import type { ReactNode } from "react";
import { Button } from "../ui";
import { ownSaveLines } from "./saveStatus";
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
          Resume saving
        </Button>
      ) : null}
      {actions?.download ? (
        <Button
          type="button"
          onClick={actions.download}
          aria-disabled={busy || undefined}
        >
          Download full-quality recording
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
  segmentList = true,
}: {
  progress: RecordUploadProgress;
  stopped: boolean;
  alive?: boolean;
  onResume?: () => void;
  /** Keeper download / recovery; the Recover rule is owned here. */
  actions?: KeeperRecoveryActions;
  /** The host panel lists every participant's segments itself, host included. */
  segmentList?: boolean;
}) {
  const canRecover = stopped && progress.recoverable;
  let status: ReactNode = null;
  let showRecoveryActions = Boolean(progress.reclaimMismatch);
  if (progress.error) {
    showRecoveryActions = true;
    status = (
      <div id={UPLOAD_STATUS_ID} className="record-warn">
        <p>{progress.error}</p>
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
    ) : progress.reclaimMismatch ? null : (
      <p id={UPLOAD_STATUS_ID}>{UPLOAD_DONE_COPY}</p>
    );
  } else if (stopped && progress.fileAck && !progress.landed) {
    status = <p id={UPLOAD_STATUS_ID}>{UPLOAD_WAITING_TO_LAND_COPY}</p>;
  } else if (
    progress.uploading ||
    (progress.pending && progress.total > 0) ||
    (stopped && !progress.fileAck)
  ) {
    showRecoveryActions = showRecoveryActions || stopped;
    status = (
      <div id={UPLOAD_STATUS_ID}>
        <p>{uploadProgressCopy(progress.acked, progress.total)}</p>
      </div>
    );
  }
  // One segment reads as the status line above; a list only earns its place
  // when several segments could each be in a different state.
  const segmentLines =
    segmentList && progress.segments.length > 1
      ? ownSaveLines(progress.segments)
      : [];
  return (
    <>
      {status}
      {segmentLines.length > 0 ? (
        <ul
          aria-label="Your full-quality recording status"
          className="record-roster"
        >
          {segmentLines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      ) : null}
      {progress.reclaimMismatch ? (
        <div className="record-warn" role="status">
          <p>{KEEPER_RECLAIM_MISMATCH_COPY}</p>
        </div>
      ) : null}
      {showRecoveryActions ? (
        <RecoveryActions
          onResume={onResume}
          actions={actions}
          canRecover={canRecover}
        />
      ) : null}
      <ActionFeedback actions={actions} />
    </>
  );
}
