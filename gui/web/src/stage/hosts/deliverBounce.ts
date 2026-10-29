import {
  type BounceOptions,
  type BounceState,
  bounceRangeSummary,
  bounceResultCopy,
} from "../../stages/deliver/bounceLogic";
import type { ExactRangeTarget } from "../../types/project";
import { lateCancelCopy } from "../../utils/pipeline";
import {
  pipelineProgressPercent,
  pipelineUnitsLabel,
  staleUpdateLabel,
} from "../../utils/pipelineProgress";
import { formatTimeShort } from "../../utils/time";
import type { BounceFlow } from "./bounceFlowContext";
import { exportFileName } from "./exportSettings";

export const BOUNCE_STARTING_REASON =
  "The bounce is still starting. Cancel once it has started.";
export const BOUNCE_CANCELLING_REASON = "Already cancelling the bounce.";
export const BOUNCE_CANCELLING_DETAIL = "Cancelling…";
export const BOUNCE_CANCELLED_NOTHING =
  "Bounce cancelled. Files from an earlier bounce are unchanged.";

/** The stage's bounce state for the flow, with `nowSec` for the stall notice. */
export function bounceStateOf(flow: BounceFlow, nowSec: number): BounceState {
  const { run, job } = flow;
  switch (run.kind) {
    case "idle":
      return { phase: "idle" };
    case "running": {
      const detail = [
        run.cancelling
          ? BOUNCE_CANCELLING_DETAIL
          : (job?.message ?? "Starting bounce…"),
        pipelineUnitsLabel(job),
        `Elapsed ${formatTimeShort(job?.elapsed_sec ?? 0)}`,
        staleUpdateLabel(job?.last_progress_at, nowSec),
      ]
        .filter(Boolean)
        .join(" · ");
      const percent = pipelineProgressPercent(job);
      return {
        phase: "running",
        progress: percent === null ? null : percent / 100,
        detail,
        cancelReason: run.cancelling
          ? BOUNCE_CANCELLING_REASON
          : run.jobId === null
            ? BOUNCE_STARTING_REASON
            : undefined,
        cancelError: run.cancelError ?? undefined,
      };
    }
    case "done":
      return {
        phase: "done",
        files: run.paths.map(exportFileName),
        summary: bounceResultCopy(run.paths),
      };
    case "failed":
      return { phase: "failed", cause: run.reason };
    case "cancelled":
      return {
        phase: "cancelled",
        files: run.paths.map(exportFileName),
        detail: run.paths.length
          ? lateCancelCopy(bounceResultCopy(run.paths))
          : BOUNCE_CANCELLED_NOTHING,
      };
  }
}

/** What the Deliver stage shows for Bounce, from the flow and what the project has selected. */
export function bounceOptionsOf(
  flow: BounceFlow,
  nowSec: number,
  project: {
    selectedCount: number;
    soloCount: number;
    hasRegion: boolean;
    range: ExactRangeTarget | null;
    clearRange: () => void;
    blockedReason?: string;
    focusRequested: boolean;
    onFocused: () => void;
  },
): BounceOptions {
  const { run } = flow;
  return {
    state: bounceStateOf(flow, nowSec),
    choices: flow.choices,
    onChoices: flow.setChoices,
    selectedCount: project.selectedCount,
    soloCount: project.soloCount,
    hasRegion: project.hasRegion,
    fixedRange: project.range ? bounceRangeSummary(project.range) : undefined,
    rangeIsRunning:
      run.kind === "running" &&
      project.range !== null &&
      run.range === project.range,
    onClearRange: project.range ? project.clearRange : undefined,
    gate: flow.gate,
    blockedReason: project.blockedReason,
    onBounce: flow.start,
    onCancel: flow.cancel,
    onAgain:
      run.kind === "failed" || run.kind === "cancelled"
        ? flow.again
        : undefined,
    focusRequested: project.focusRequested,
    onFocused: project.onFocused,
  };
}
