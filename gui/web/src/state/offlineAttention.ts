import { useCallback, useSyncExternalStore } from "react";
import { shareTokenFromKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "./documentSendOrder";
import {
  clearConflicts,
  clearHostConflicts,
  loadGuestAttention,
  loadHostAttention,
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
  /** A send is in flight, or ended and the queue has not been read since. */
  settling: boolean;
};

export const ATTENTION_POLL_MS = 2_000;

const INITIAL: AttentionSnapshot = {
  pending: 0,
  conflicts: [],
  status: "checking",
  loaded: false,
  settling: false,
};

type Source = {
  snapshot: AttentionSnapshot;
  listeners: Set<() => void>;
  generation: number;
  stop: () => void;
};

const sources = new Map<string, Source>();
const volatileOutcomes = new Map<string, OfflineConflict[]>();

export function volatileOutcomeFor(
  projectPath: string,
  commandId: string,
): OfflineConflict | undefined {
  return volatileOutcomes
    .get(projectPath)
    ?.find((outcome) => outcome.command.command_id === commandId);
}

function read(projectPath: string): Promise<[number, OfflineConflict[]]> {
  const token = shareTokenFromKey(projectPath);
  const stored = token
    ? loadGuestAttention(token)
    : loadHostAttention(projectPath);
  return stored.then(({ pending, conflicts }) => {
    const byCommand = new Map(
      conflicts.map((conflict) => [conflict.command.command_id, conflict]),
    );
    for (const conflict of volatileOutcomes.get(projectPath) ?? []) {
      byCommand.set(conflict.command.command_id, conflict);
    }
    return [pending, [...byCommand.values()]] as [number, OfflineConflict[]];
  });
}

function withVolatileOutcomes(
  projectPath: string,
  conflicts: readonly OfflineConflict[],
): OfflineConflict[] {
  const byCommand = new Map(
    conflicts.map((conflict) => [conflict.command.command_id, conflict]),
  );
  for (const conflict of volatileOutcomes.get(projectPath) ?? []) {
    byCommand.set(conflict.command.command_id, conflict);
  }
  return [...byCommand.values()];
}

export function recordVolatileOutcome(
  projectPath: string,
  conflict: OfflineConflict,
): void {
  const current = volatileOutcomes.get(projectPath) ?? [];
  volatileOutcomes.set(projectPath, [
    ...current.filter(
      (item) => item.command.command_id !== conflict.command.command_id,
    ),
    conflict,
  ]);
  const source = sources.get(projectPath);
  if (source) {
    set(source, {
      conflicts: withVolatileOutcomes(projectPath, source.snapshot.conflicts),
    });
  }
}

export function clearVolatileOutcome(
  projectPath: string,
  commandId: string,
): void {
  const remaining = (volatileOutcomes.get(projectPath) ?? []).filter(
    (item) => item.command.command_id !== commandId,
  );
  if (remaining.length) volatileOutcomes.set(projectPath, remaining);
  else volatileOutcomes.delete(projectPath);
  const source = sources.get(projectPath);
  if (source) {
    set(source, {
      conflicts: withVolatileOutcomes(
        projectPath,
        source.snapshot.conflicts.filter(
          (item) => item.command.command_id !== commandId,
        ),
      ),
    });
  }
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
      set(source, {
        pending,
        conflicts: withVolatileOutcomes(projectPath, conflicts),
        status: "ready",
        loaded: true,
        settling: documentActivityBusy(projectPath),
      });
    })
    .catch(() => {
      if (reading === source.generation) {
        set(source, {
          status: "unreadable",
          settling: documentActivityBusy(projectPath),
        });
      }
    });
}

function start(projectPath: string): Source {
  let busy = documentActivityBusy(projectPath);
  const source: Source = {
    snapshot: { ...INITIAL, settling: busy },
    listeners: new Set(),
    generation: 0,
    stop: () => {},
  };
  const unsubscribe = subscribeDocumentActivity(() => {
    const now = documentActivityBusy(projectPath);
    if (now && !busy) set(source, { settling: true });
    // A save or drain just ended, and its queue cleanup is done: read the result now.
    // `settling` holds until that read lands, so the stale snapshot never reads as saved.
    if (busy && !now) {
      set(source, { settling: true });
      refresh(projectPath, source);
    }
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
        volatileOutcomes.delete(projectPath);
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
