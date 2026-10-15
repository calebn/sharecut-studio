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

export function lastMode(target: string): PrecisionDecision["mode"] | null {
  return log.find((e) => e.target === target)?.decision.mode ?? null;
}

export function resetDecisionLog(): void {
  log = [];
}
