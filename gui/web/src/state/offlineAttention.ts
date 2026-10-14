import { useCallback, useSyncExternalStore } from "react";
import { shareTokenFromKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "./documentSendOrder";
import {
  clearConflicts,
  clearHostConflicts,
  loadCommandQueue,
  loadConflicts,
  loadHostCommandCount,
  loadHostConflicts,
  type OfflineConflict,
} from "./offlineStore";

export type AttentionStatus =
  | "checking"
  | "ready"
  | "unreadable"
  | "retrying"
  | "dismissing";

/** What the project's persisted offline queue and conflict list hold, as last read. */
export type AttentionSnapshot = {
  /** Host edits queued but not yet applied (always 0 for a share guest). */
  pending: number;
  conflicts: readonly OfflineConflict[];
  status: AttentionStatus;
  /** True once a read of this project has succeeded. */
  loaded: boolean;
};

export const ATTENTION_POLL_MS = 2_000;

const INITIAL: AttentionSnapshot = {
  pending: 0,
  conflicts: [],
  status: "checking",
  loaded: false,
};

type Source = {
  snapshot: AttentionSnapshot;
  listeners: Set<() => void>;
  generation: number;
  stop: () => void;
};

const sources = new Map<string, Source>();

function read(projectPath: string): Promise<[number, OfflineConflict[]]> {
  const token = shareTokenFromKey(projectPath);
  const queue = token
    ? loadCommandQueue(token).then(() => 0)
    : loadHostCommandCount(projectPath);
  const conflicts = token
    ? loadConflicts(token)
    : loadHostConflicts(projectPath);
  return Promise.all([queue, conflicts]);
}

function set(source: Source, patch: Partial<AttentionSnapshot>): void {
  source.snapshot = { ...source.snapshot, ...patch };
  for (const listener of [...source.listeners]) listener();
}

function refresh(projectPath: string, source: Source): void {
  const { status } = source.snapshot;
  if (status === "dismissing") return;
  const reading = ++source.generation;
  set(source, {
    status:
      status === "unreadable" || status === "retrying"
        ? "retrying"
        : "checking",
  });
  read(projectPath)
    .then(([pending, conflicts]) => {
      if (reading !== source.generation) return;
      set(source, { pending, conflicts, status: "ready", loaded: true });
    })
    .catch(() => {
      if (reading === source.generation) set(source, { status: "unreadable" });
    });
}

function start(projectPath: string): Source {
  const source: Source = {
    snapshot: INITIAL,
    listeners: new Set(),
    generation: 0,
    stop: () => {},
  };
  let busy = documentActivityBusy(projectPath);
  const unsubscribe = subscribeDocumentActivity(() => {
    const now = documentActivityBusy(projectPath);
    // A save or drain just ended, and its queue cleanup is done: read the result now.
    if (busy && !now) refresh(projectPath, source);
    busy = now;
  });
  const timer = window.setInterval(
    () => refresh(projectPath, source),
    ATTENTION_POLL_MS,
  );
  source.stop = () => {
    source.generation++;
    unsubscribe();
    window.clearInterval(timer);
  };
  refresh(projectPath, source);
  return source;
}

function subscribe(projectPath: string, listener: () => void): () => void {
  let source = sources.get(projectPath);
  if (!source) {
    source = start(projectPath);
    sources.set(projectPath, source);
  }
  source.listeners.add(listener);
  return () => {
    const current = sources.get(projectPath);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop();
      sources.delete(projectPath);
    }
  };
}

/** Read the queue and conflicts again now, e.g. after a Retry. */
export function refreshOfflineAttention(projectPath: string): void {
  const source = sources.get(projectPath);
  if (source) refresh(projectPath, source);
}

/** Clear the project's conflict list. A no-op unless the last read succeeded. */
export function dismissAllConflicts(projectPath: string): void {
  const source = sources.get(projectPath);
  if (!source || source.snapshot.status !== "ready") return;
  const clearing = ++source.generation;
  set(source, { status: "dismissing" });
  const token = shareTokenFromKey(projectPath);
  (token ? clearConflicts(token) : clearHostConflicts(projectPath))
    .then(() => {
      if (clearing === source.generation) {
        set(source, { conflicts: [], status: "ready" });
      }
    })
    .catch(() => {
      if (clearing === source.generation) set(source, { status: "unreadable" });
    });
}

/**
 * The persisted offline queue and conflicts for a project: one shared poll per
 * project however many components read it. `null` reads nothing. The "Needs attention" banner lists
 * them and the save state counts them.
 */
export function useOfflineAttention(
  projectPath: string | null,
): AttentionSnapshot {
  const follow = useCallback(
    (listener: () => void) =>
      projectPath ? subscribe(projectPath, listener) : () => undefined,
    [projectPath],
  );
  return useSyncExternalStore(
    follow,
    () => (projectPath && sources.get(projectPath)?.snapshot) || INITIAL,
  );
}
