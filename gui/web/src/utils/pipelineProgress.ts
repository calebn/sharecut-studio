import type { PipelineJobSnapshot } from "../types/pipeline";
import { modelNeededOfJob, notDownloadedLine } from "./apiError";
import { isAnalyzeJob, isPipelineKindJob } from "./pipeline";
import { plainError } from "./plainError";
import { stepActivity } from "./prepareRows";

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

/** Unit noun for a job's `current/total`: Analyze counts dialogue tracks, Split speakers embedded windows, everything else steps. */
export function pipelineUnitNoun(
  kind: PipelineJobSnapshot["kind"] | undefined,
): string {
  if (kind === "split_speakers") {
    return "windows";
  }
  return isAnalyzeJob({ kind }) ? "tracks" : "steps";
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

/**
 * One sentence for a job's state: "Pipeline is running", "Activity failed".
 * The job's own message is not part of it; callers add it, filtered by
 * `plainError` for a failed job.
 */
export function pipelineStateSentence(
  job: Pick<PipelineJobSnapshot, "kind" | "status">,
): string {
  const subject = pipelineKindLabel(job.kind);
  switch (job.status) {
    case "ok":
      return `${subject} finished`;
    case "error":
      return `${subject} failed`;
    case "cancelled":
      return `${subject} was cancelled`;
    case "queued":
      return `${subject} is waiting`;
    default:
      return `${subject} is running`;
  }
}

const RUNNING_STEP = /^Running (\w+)$/;
const COMPLETED_STEP = /^Completed \w+(:|$)/;

/**
 * A running or finished pipeline job's message without the engine's step ids
 * and summaries: "Running <id>" becomes the row's activity or nothing, and
 * "Completed <id>" with or without a summary goes. Other jobs and messages are unchanged.
 */
function plainJobMessage(
  job: Pick<PipelineJobSnapshot, "kind" | "status">,
  message: string,
): string {
  if (!isPipelineKindJob(job) || job.status === "error") return message;
  const running = RUNNING_STEP.exec(message);
  if (running) return stepActivity(running[1]!) ?? "";
  return COMPLETED_STEP.test(message) ? "" : message;
}

/** The job's message (or label when it has none), safe to show or speak. */
export function jobHeadline(
  job: Pick<PipelineJobSnapshot, "kind" | "status" | "message" | "label">,
): string | undefined {
  return (
    (job.message ? plainJobMessage(job, job.message) : "") ||
    (job.label ?? undefined)
  );
}

/** Chip prefix: "Pipeline" only for pipeline jobs; "Activity" otherwise. */
export function pipelineKindLabel(
  kind: PipelineJobSnapshot["kind"] | undefined,
): string {
  if (kind == null || isPipelineKindJob({ kind })) {
    return "Pipeline";
  }
  return "Activity";
}

/** Compact chip text for a live job. */
export function pipelineChromeLabel(
  job: PipelineJobSnapshot,
  options?: { headlineMax?: number },
): string {
  const parts = [pipelineStateSentence(job)];
  if (job.status === "cancelled") return parts[0]!;
  const model = modelNeededOfJob(job);
  const text = model ? notDownloadedLine(model) : jobHeadline(job);
  const headline = truncateHeadline(
    text && job.status === "error" && !model ? plainError(text) : text,
    options?.headlineMax ?? 48,
  );
  if (headline) {
    parts.push(headline);
  }
  const units = pipelineUnitsLabel(job, pipelineUnitNoun(job.kind));
  if (units) {
    parts.push(units);
  }
  return parts.join(" · ");
}

/** Seconds without a domain progress event before chrome shows stale copy. */
export const STALE_AFTER_S = 15;

/** True when a running job has gone `STALE_AFTER_S` without a progress event. */
export function isStaleUpdate(
  lastProgressAt: number | null | undefined,
  nowSec: number,
): boolean {
  return lastProgressAt != null && nowSec - lastProgressAt > STALE_AFTER_S;
}

/** Honest stall copy — not a moving bar. Null when heartbeats are still arriving. */
export function staleUpdateLabel(
  lastProgressAt: number | null | undefined,
  nowSec: number,
): string | null {
  if (lastProgressAt == null || !isStaleUpdate(lastProgressAt, nowSec)) {
    return null;
  }
  return `last update ${Math.floor(nowSec - lastProgressAt)}s ago`;
}
