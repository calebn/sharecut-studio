import { MIN_STEP_GAP_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";

/** `_first_step_clearance`: the latest source second an in edge may take. */
export function firstStepClearance(clip: ClipRow): number {
  const first = clip.timing?.steps[0];
  if (!first) return Number.POSITIVE_INFINITY;
  return Math.max(clip.source_start, first.at - MIN_STEP_GAP_SEC);
}

/** `_last_step_clearance`: the earliest source second an out edge may take. */
export function lastStepClearance(clip: ClipRow): number {
  const last = clip.timing?.steps.at(-1);
  if (!last) return Number.NEGATIVE_INFINITY;
  return Math.min(
    clip.source_end,
    last.at + Math.max(0, -last.delta_sec) + MIN_STEP_GAP_SEC,
  );
}
