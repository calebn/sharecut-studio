/**
 * The last `DECISION_LOG_SIZE` Auto precision decisions (#1184), in memory,
 * newest first, so the owner can report the ones Auto got wrong from View ›
 * Labs › Auto decisions. Also the history hysteresis reads.
 */
import { useSyncExternalStore } from "react";
import { decisionText, type PrecisionDecision } from "./precisionDecision";

export const DECISION_LOG_SIZE = 20;

export interface LoggedDecision {
  /** `Date.now()` when the target was armed. */
  at: number;
  /** "trim-out:clip_1": the armed target's kind and id. */
  target: string;
  /** "Trim end". */
  name: string;
  decision: PrecisionDecision;
}

let log: readonly LoggedDecision[] = [];
let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function logDecision(entry: LoggedDecision): void {
  log = [entry, ...log].slice(0, DECISION_LOG_SIZE);
  emit();
}

/** The last mode `target` was armed in, if it is still in the log. */
export function lastMode(target: string): PrecisionDecision["mode"] | null {
  return log.find((e) => e.target === target)?.decision.mode ?? null;
}

export function decisionLog(): readonly LoggedDecision[] {
  return log;
}

/** One line per decision, newest first, for pasting into a report. */
export function decisionLogText(entries = log): string {
  return entries
    .map(
      (e) =>
        `${new Date(e.at).toISOString()} ${e.name} (${e.target}): ${decisionText(e.decision)}`,
    )
    .join("\n");
}

export function setDecisionLogOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDecisionLog(): {
  entries: readonly LoggedDecision[];
  open: boolean;
} {
  const entries = useSyncExternalStore(subscribe, () => log);
  const isOpen = useSyncExternalStore(subscribe, () => open);
  return { entries, open: isOpen };
}
