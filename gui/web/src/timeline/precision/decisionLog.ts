/**
 * Recent Auto precision decisions (#1184), in memory, for hysteresis when the
 * same target is armed again.
 */
import { type PrecisionDecision } from "./precisionDecision";

export const DECISION_LOG_SIZE = 20;

export interface LoggedDecision {
  at: number;
  target: string;
  name: string;
  decision: PrecisionDecision;
}

let log: readonly LoggedDecision[] = [];

export function logDecision(entry: LoggedDecision): void {
  log = [entry, ...log].slice(0, DECISION_LOG_SIZE);
}

/** The last mode `target` was armed in, if it is still in the log. */
export function lastMode(target: string): PrecisionDecision["mode"] | null {
  return log.find((e) => e.target === target)?.decision.mode ?? null;
}

/** Clears the log between tests. */
export function resetDecisionLog(): void {
  log = [];
}
