import { useSyncExternalStore } from "react";

/** How long a held refresh may sit on one commit before it counts as lost. */
export const TRANSCRIPT_STALL_MS = 35_000;

// One owner for every caller of the transcript hook: one clock per key, one
// answer for all. A key is a refresh's `path|seq|token`.
const watchers = new Map<string, { count: number; timer: number }>();
let stalled: readonly string[] = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function arm(key: string): number {
  return window.setTimeout(() => {
    if (!watchers.has(key) || stalled.includes(key)) return;
    stalled = [...stalled, key];
    emit();
  }, TRANSCRIPT_STALL_MS);
}

/** A caller shows a refresh under `key`; returns what it calls when it stops. */
export function watchTranscriptStall(key: string): () => void {
  const entry = watchers.get(key);
  if (entry) entry.count += 1;
  else watchers.set(key, { count: 1, timer: arm(key) });
  return () => {
    const now = watchers.get(key);
    if (!now) return;
    now.count -= 1;
    if (now.count > 0) return;
    window.clearTimeout(now.timer);
    watchers.delete(key);
    if (stalled.includes(key)) {
      stalled = stalled.filter((k) => k !== key);
      emit();
    }
  };
}

/** Try again: the cover goes and the clock starts over, for everyone. */
export function restartTranscriptStall(key: string): void {
  const entry = watchers.get(key);
  if (entry) {
    window.clearTimeout(entry.timer);
    entry.timer = arm(key);
  }
  if (stalled.includes(key)) {
    stalled = stalled.filter((k) => k !== key);
    emit();
  }
}

/** A new document: nothing held is stalled, and clocks start over. */
export function resetTranscriptStall(): void {
  for (const [key, entry] of watchers) {
    window.clearTimeout(entry.timer);
    entry.timer = arm(key);
  }
  if (stalled.length > 0) {
    stalled = [];
    emit();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => stalled;

export function useTranscriptStalled(key: string | null): boolean {
  const keys = useSyncExternalStore(subscribe, snapshot);
  return key !== null && keys.includes(key);
}
