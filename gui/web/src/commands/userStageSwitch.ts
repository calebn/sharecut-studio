import { isProgrammaticUi } from "../presence/followSync";

const FRESH_MS = 1000;
type StageSwitchSource = "command" | "tab";
let pending: { at: number; source: StageSwitchSource } | null = null;

/** A stage command a person ran (not a leader's Follow, not a screen's own openStage) is about to switch the stage. */
export function markUserStageSwitch(
  source: StageSwitchSource = "command",
): void {
  if (!isProgrammaticUi()) pending = { at: performance.now(), source };
}

/** Read the source once for a switch `markUserStageSwitch` announced a moment ago. */
export function takeUserStageSwitch(): StageSwitchSource | null {
  const previous = pending;
  pending = null;
  return previous && performance.now() - previous.at < FRESH_MS
    ? previous.source
    : null;
}

/** The stage command left the stage where it was (a surface or sheet argument): nothing to announce. */
export function cancelUserStageSwitch(): void {
  pending = null;
}
