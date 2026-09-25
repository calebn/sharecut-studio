import { useCallback, useSyncExternalStore } from "react";
import { loadWaveformStatus } from "../api";
import {
  type ReadyEntry,
  refKind,
  type StatusEntry,
  type WaveformKind,
  type WaveformStatus,
} from "./types";

/**
 * Pyramid status, one poller per (project, kind). A poll repeats with a
 * 1 → 2 → 4 s back-off while anything is generating and stops otherwise; a
 * media change (`WaveformStatusSync`) or a tile 404 asks again at once.
 * Entries keep their identity while unchanged, so a subscriber re-renders
 * only when its own ref changes.
 */

const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 4000;

type Poller = {
  projectPath: string;
  kind: WaveformKind;
  entries: Map<string, StatusEntry>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  inflight: AbortController | null;
  /** Another poll was asked for while one was in flight. */
  again: boolean;
  /** Keys whose tile 404 already triggered a refetch. */
  missing: Set<string>;
};

type ReadyListener = (
  projectPath: string,
  ref: string,
  entry: ReadyEntry,
) => void;

const pollers = new Map<string, Poller>();
const readyListeners = new Set<ReadyListener>();

function pollerKey(projectPath: string, kind: WaveformKind): string {
  return `${kind}\u0000${projectPath}`;
}

function pollerFor(projectPath: string, kind: WaveformKind): Poller {
  const key = pollerKey(projectPath, kind);
  let poller = pollers.get(key);
  if (!poller) {
    poller = {
      projectPath,
      kind,
      entries: new Map(),
      listeners: new Set(),
      timer: null,
      backoffMs: FIRST_BACKOFF_MS,
      inflight: null,
      again: false,
      missing: new Set(),
    };
    pollers.set(key, poller);
  }
  return poller;
}

function sameEntry(a: StatusEntry, b: StatusEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge a poll; returns whether any entry changed. */
function applyStatus(poller: Poller, status: WaveformStatus): boolean {
  let changed = false;
  const next = new Map<string, StatusEntry>();
  for (const [ref, entry] of Object.entries(status.media ?? {})) {
    const prev = poller.entries.get(ref);
    if (prev && sameEntry(prev, entry)) {
      next.set(ref, prev);
      continue;
    }
    next.set(ref, entry);
    changed = true;
    if (
      entry.status === "ready" &&
      (prev?.status !== "ready" || prev.key !== entry.key)
    ) {
      for (const fn of readyListeners) {
        fn(poller.projectPath, ref, entry);
      }
    }
  }
  if (next.size !== poller.entries.size) {
    changed = true;
  }
  poller.entries = next;
  return changed;
}

function clearTimer(poller: Poller): void {
  if (poller.timer != null) {
    clearTimeout(poller.timer);
    poller.timer = null;
  }
}

function schedule(poller: Poller): void {
  clearTimer(poller);
  if (poller.listeners.size === 0) {
    return;
  }
  poller.timer = setTimeout(() => {
    poller.timer = null;
    poll(poller);
  }, poller.backoffMs);
  poller.backoffMs = Math.min(poller.backoffMs * 2, MAX_BACKOFF_MS);
}

function poll(poller: Poller): void {
  if (poller.inflight) {
    poller.again = true;
    return;
  }
  clearTimer(poller);
  const controller = new AbortController();
  poller.inflight = controller;
  loadWaveformStatus(poller.projectPath, poller.kind, controller.signal)
    .then((status) => {
      if (controller.signal.aborted) {
        return;
      }
      poller.inflight = null;
      if (applyStatus(poller, status)) {
        for (const fn of [...poller.listeners]) {
          fn();
        }
      }
      if (poller.again) {
        poller.again = false;
        poll(poller);
        return;
      }
      const generating = [...poller.entries.values()].some(
        (e) => e.status === "generating",
      );
      if (generating) {
        schedule(poller);
      } else {
        poller.backoffMs = FIRST_BACKOFF_MS;
      }
    })
    .catch(() => {
      if (controller.signal.aborted) {
        return;
      }
      poller.inflight = null;
      // Offline or a transient failure: try again, backing off.
      schedule(poller);
    });
}

/** Watch one project's status; the first subscriber starts polling. */
export function subscribeWaveformStatus(
  projectPath: string,
  kind: WaveformKind,
  listener: () => void,
): () => void {
  const poller = pollerFor(projectPath, kind);
  poller.listeners.add(listener);
  if (poller.listeners.size === 1 && !poller.inflight) {
    poll(poller);
  }
  return () => {
    poller.listeners.delete(listener);
    if (poller.listeners.size === 0) {
      clearTimer(poller);
    }
  };
}

/** The last status entry of `ref`, or null before it is listed. */
export function getWaveformStatusEntry(
  projectPath: string,
  kind: WaveformKind,
  ref: string,
): StatusEntry | null {
  return pollers.get(pollerKey(projectPath, kind))?.entries.get(ref) ?? null;
}

/** Poll again now (media changed); `kind` omitted asks both kinds. */
export function refreshWaveformStatus(
  projectPath: string,
  kind?: WaveformKind,
): void {
  for (const k of kind ? [kind] : (["raw", "stem"] as const)) {
    const poller = pollers.get(pollerKey(projectPath, k));
    if (poller && poller.listeners.size > 0) {
      poller.backoffMs = FIRST_BACKOFF_MS;
      poll(poller);
    }
  }
}

/** A tile 404: the key may be gone. Poll again, once per key. */
export function noteWaveformTileMissing(
  projectPath: string,
  ref: string,
  key: string,
): void {
  const poller = pollerFor(projectPath, refKind(ref));
  if (poller.missing.has(key)) {
    return;
  }
  poller.missing.add(key);
  poll(poller);
}

/** Called when a ref becomes ready (or ready under a new key). */
export function onWaveformReady(listener: ReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** Stop and forget every poller (a project switch, tests). */
export function resetWaveformStatus(): void {
  for (const poller of pollers.values()) {
    clearTimer(poller);
    poller.inflight?.abort();
  }
  pollers.clear();
}

/** Forget pollers of other projects. */
export function retainWaveformStatus(projectPath: string): void {
  for (const [key, poller] of pollers) {
    if (poller.projectPath !== projectPath) {
      clearTimer(poller);
      poller.inflight?.abort();
      pollers.delete(key);
    }
  }
}

/** One ref's status entry, re-rendering only when that entry changes. */
export function useWaveformStatus(
  projectPath: string,
  kind: WaveformKind,
  ref: string | null,
): StatusEntry | null {
  const subscribe = useCallback(
    (fn: () => void) =>
      projectPath ? subscribeWaveformStatus(projectPath, kind, fn) : () => {},
    [projectPath, kind],
  );
  const snapshot = () =>
    ref ? getWaveformStatusEntry(projectPath, kind, ref) : null;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
