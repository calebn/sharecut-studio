import type { PipelineJobSnapshot } from "../../types/pipeline";
import { StaleProgressCopy } from "../../ui/StaleProgressCopy";
import { isPipelineRunning } from "../../utils/pipeline";
import {
  pipelineProgressPercent,
  pipelineUnitsLabel,
} from "../../utils/pipelineProgress";
import { formatTimeShort } from "../../utils/time";

type Props = {
  job: PipelineJobSnapshot | null;
  /** The status line; the job's own message when omitted. */
  headline?: string;
  /** Unit for the `current/total` companion; omit it to show the bar alone. */
  unit?: string | null;
  barLabel: string;
  startingCopy: string;
  /** Fixed wall-clock seconds for catalog previews; omit to tick live. */
  nowSec?: number;
};

/**
 * One job's live status inside a dialog: headline, units, an honest bar (only
 * with a real total), and elapsed time. The job start, cancel and what the
 * dialog says around it stay with each dialog.
 */
export function JobProgressView({
  job,
  headline,
  unit = "steps",
  barLabel,
  startingCopy,
  nowSec,
}: Props) {
  const pct = pipelineProgressPercent(job);
  const units = unit == null ? null : pipelineUnitsLabel(job, unit);
  const running = job == null || isPipelineRunning(job);
  return (
    <>
      <div
        className="export-dialog-progress"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={running || undefined}
      >
        <span className="pipeline-headline">
          {headline ?? job?.message ?? startingCopy}
        </span>
        {units ? <span>{units}</span> : null}
        {pct == null && running ? (
          <span className="pipeline-pulse" aria-hidden="true" />
        ) : null}
      </div>
      {pct != null ? (
        <div
          className="pipeline-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuenow={pct}
          aria-valuemax={100}
          aria-label={barLabel}
        >
          <div className="pipeline-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="export-dialog-note">
        <span className="pipeline-elapsed">
          Elapsed {formatTimeShort(job?.elapsed_sec ?? 0)}
        </span>
        <StaleProgressCopy
          lastProgressAt={job?.last_progress_at}
          running={running}
          prefix=" · "
          nowSec={nowSec}
        />
      </p>
    </>
  );
}
