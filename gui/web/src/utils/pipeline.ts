import type { PipelineJobSnapshot } from "../types/pipeline";

const PIPELINE_SLOT_KINDS = new Set<string>([
  "pipeline",
  "bounce",
  "export",
  "render_preview",
  "analyze",
]);

/** Pipeline tab jobs — not bounce/export/agent/render-preview/analyze chrome. */
export function isPipelineKindJob(
  job: Pick<PipelineJobSnapshot, "kind"> | null | undefined,
): boolean {
  return (job?.kind ?? "pipeline") === "pipeline";
}

/** Single-flight slot jobs (pipeline / bounce / export / render_preview / analyze). */
export function isPipelineSlotJob(
  job: Pick<PipelineJobSnapshot, "kind"> | null | undefined,
): boolean {
  return PIPELINE_SLOT_KINDS.has(job?.kind ?? "pipeline");
}

/** Pipeline tab Analyze (kind=analyze): a slot job whose progress the Pipeline tab shows itself. */
export function isAnalyzeJob(
  job: Pick<PipelineJobSnapshot, "kind"> | null | undefined,
): boolean {
  return job?.kind === "analyze";
}

export function isPipelineRunning(
  job: PipelineJobSnapshot | null | undefined,
): boolean {
  return job?.status === "running" || job?.status === "queued";
}

/** True for a job status that ends a wait (mirrors backend `TERMINAL_JOB_STATUSES`). */
export function isTerminalJobStatus(status: string): boolean {
  return status === "ok" || status === "error" || status === "cancelled";
}

/** True when a slot job occupies the shared pipeline lock. */
export function isPipelineSlotBusy(
  job: PipelineJobSnapshot | null | undefined,
): boolean {
  return isPipelineSlotJob(job) && isPipelineRunning(job);
}

/** Chip may open Pipeline only when Cancel / slot-busy chrome lives there. */
export function pipelineChipOpensPanel(
  job: Pick<PipelineJobSnapshot, "kind"> | null | undefined,
): boolean {
  return isPipelineSlotJob(job);
}

/** Artifact paths from a terminal bounce/export snapshot. */
export function jobResultPaths(
  job: Pick<PipelineJobSnapshot, "result"> | null | undefined,
): string[] {
  const raw = job?.result?.paths;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string");
}
