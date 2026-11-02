import { isProgrammaticUi } from "../presence/followSync";

const FRESH_MS = 1000;
let markedAt = Number.NEGATIVE_INFINITY;

/** A stage command a person ran (not a leader's Follow, not a screen's own openStage) is about to switch the stage. */
export function markUserStageSwitch(): void {
  if (!isProgrammaticUi()) markedAt = performance.now();
}

/** True once for a switch `markUserStageSwitch` announced a moment ago. */
export function takeUserStageSwitch(): boolean {
  const fresh = performance.now() - markedAt < FRESH_MS;
  markedAt = Number.NEGATIVE_INFINITY;
  return fresh;
}

/** The stage command left the stage where it was (a surface or sheet argument): nothing to announce. */
export function cancelUserStageSwitch(): void {
  markedAt = Number.NEGATIVE_INFINITY;
}
