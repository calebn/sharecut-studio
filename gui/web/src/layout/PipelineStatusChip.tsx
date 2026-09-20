import type { MouseEventHandler } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { formatElapsed } from "../utils/format";
import { isPipelineRunning } from "../utils/pipeline";
import { pipelineChromeLabel } from "../utils/pipelineProgress";
import { StaleProgressCopy } from "./StaleProgressCopy";

type Props = {
  job: PipelineJobSnapshot;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  headlineMax?: number;
  runningCount?: number;
};

/** Shared StatusBar / phone Listen pipeline chrome (headline, elapsed, pulse). */
export function PipelineStatusChip({
  job,
  onClick,
  headlineMax,
  runningCount = 1,
}: Props) {
  const running = isPipelineRunning(job);
  const copy = (
    <span className="status-pipeline-copy">
      {pipelineChromeLabel(
        job,
        headlineMax != null ? { headlineMax } : undefined,
      )}
      <StaleProgressCopy
        lastProgressAt={job.last_progress_at}
        running={running}
        prefix=" · "
      />
      {` · ${formatElapsed(job.elapsed_sec)}`}
    </span>
  );
  const count =
    runningCount > 1 ? (
      <span className="activity-count-badge">{` · ${runningCount} activities`}</span>
    ) : null;
  const pulse = running ? (
    <span className="pipeline-pulse" aria-hidden="true" />
  ) : null;
  const className = `ui-control status-pipeline${running ? " running" : ""}${
    onClick == null ? " status-pipeline--static" : ""
  }`;
  if (onClick == null) {
    return (
      <span className={className} aria-busy={running || undefined}>
        {copy}
        {count}
        {pulse}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-busy={running || undefined}
    >
      {copy}
      {count}
      {pulse}
    </button>
  );
}
