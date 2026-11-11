import type { BounceRequest } from "../edit/exportRange";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { isTerminalJobStatus } from "../utils/pipeline";
import type { ExecuteResult } from "./types";

export type BounceRunner = {
  start(request: BounceRequest): Promise<ExecuteResult>;
  cancel(): Promise<ExecuteResult>;
  running(): boolean;
};

export const EXPORT_BUSY_REASON = "Another export is running.";
export const EXPORT_STARTING_REASON = "Export is still starting";
const UNAVAILABLE: ExecuteResult = {
  status: "disabled",
  reason: "Export is not available here",
};

const BUSY_KINDS: ReadonlySet<string> = new Set([
  "export",
  "pipeline",
  "bounce",
]);

let runner: BounceRunner | null = null;

export function registerBounceRunner(next: BounceRunner): () => void {
  runner = next;
  return () => {
    if (runner === next) runner = null;
  };
}

export function startBounce(request: BounceRequest): Promise<ExecuteResult> {
  return runner ? runner.start(request) : Promise.resolve(UNAVAILABLE);
}

export function bounceRunning(): boolean {
  return runner?.running() ?? false;
}

export function cancelBounce(): Promise<ExecuteResult> {
  return runner ? runner.cancel() : Promise.resolve(UNAVAILABLE);
}

/** Why an export cannot start while the Activity slot holds a live export, pipeline or bounce; null when it can. */
export function exportBusyReason(
  job: Pick<PipelineJobSnapshot, "kind" | "status"> | null,
): string | null {
  return job?.kind !== undefined &&
    BUSY_KINDS.has(job.kind) &&
    !isTerminalJobStatus(job.status)
    ? EXPORT_BUSY_REASON
    : null;
}
