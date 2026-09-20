import type { PipelineJobSnapshot } from "../types/pipeline";
import { isPipelineKindJob, isPipelineRunning } from "./pipeline";

/** True when the job has an honest determinate total (no fake %). */
export function hasDeterminateProgress(
  job: Pick<PipelineJobSnapshot, "current" | "total"> | null | undefined,
): boolean {
  return job?.total != null && job.total > 0 && job.current != null;
}

/** Percent 0–100 when determinate; otherwise null (hide the bar). */
export function pipelineProgressPercent(
  job: Pick<PipelineJobSnapshot, "current" | "total"> | null | undefined,
): number | null {
  if (!hasDeterminateProgress(job) || job == null) {
    return null;
  }
  return Math.min(100, Math.round((job.current! / job.total!) * 100));
}

/** Units companion like "1/2 steps"; omit when total is unknown. */
export function pipelineUnitsLabel(
  job: Pick<PipelineJobSnapshot, "current" | "total"> | null | undefined,
  unit = "steps",
): string | null {
  if (!hasDeterminateProgress(job) || job == null) {
    return null;
  }
  return `${job.current}/${job.total} ${unit}`;
}

export function truncateHeadline(
  message: string | null | undefined,
  maxLen = 48,
): string | null {
  if (!message) {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Distinct terminal / running labels for chrome (fail ≠ cancel). */
export function pipelineStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "ok";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
      return "queued";
    case "running":
      return "running";
    default:
      return status;
  }
}

/** StatusBar prefix: "Pipeline" only for pipeline jobs; "Activity" otherwise. */
export function pipelineKindLabel(
  kind: PipelineJobSnapshot["kind"] | undefined,
): string {
  if (kind == null || isPipelineKindJob({ kind })) {
    return "Pipeline";
  }
  return "Activity";
}

/** Compact StatusBar / phone chip text for a live job. */
export function pipelineChromeLabel(
  job: PipelineJobSnapshot,
  options?: { headlineMax?: number },
): string {
  const parts = [
    `${pipelineKindLabel(job.kind)}: ${pipelineStatusLabel(job.status)}`,
  ];
  const headline = truncateHeadline(
    job.message || job.label,
    options?.headlineMax ?? 48,
  );
  if (headline) {
    parts.push(headline);
  }
  const units = pipelineUnitsLabel(job);
  if (units) {
    parts.push(units);
  }
  return parts.join(" · ");
}

/** True while the job is running — pulse for busy chrome; bar is separate. */
export function showIndeterminatePulse(
  job: PipelineJobSnapshot | null | undefined,
): boolean {
  return isPipelineRunning(job);
}

/** Seconds without a domain progress event before chrome shows stale copy. */
export const STALE_AFTER_S = 15;

/** Honest stall copy — not a moving bar. Null when heartbeats are still arriving. */
export function staleUpdateLabel(
  lastProgressAt: number | null | undefined,
  nowSec: number,
): string | null {
  if (lastProgressAt == null) {
    return null;
  }
  const lag = nowSec - lastProgressAt;
  if (lag <= STALE_AFTER_S) {
    return null;
  }
  return `last update ${Math.floor(lag)}s ago`;
}
