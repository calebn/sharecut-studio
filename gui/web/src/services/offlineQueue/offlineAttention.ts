import { useCallback, useSyncExternalStore } from "react";
import { shareTokenFromKey } from "../../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../../state/documentSendOrder";
import {
  dismissConflicts,
  dismissHostConflicts,
  loadGuestAttention,
  loadHostAttention,
  type OfflineConflict,
} from "./offlineStore";

export type AttentionStatus =
  | "checking"
  | "ready"
  | "unreadable"
  | "retrying"
  | "dismissing"
  | "dismiss-failed";

/** What the project's persisted offline queue and conflict list hold, as last read. */
export type AttentionSnapshot = {
  /** Host edits queued but not yet applied (always 0 for a share guest). */
  pending: number;
  conflicts: readonly OfflineConflict[];
  recoverySelection: OfflineConflict | null;
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
  recoverySelection: null,
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
const volatileOutcomeInstances = new WeakSet<OfflineConflict>();

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
    return [pending, withVolatileOutcomes(projectPath, conflicts)] as [
      number,
      OfflineConflict[],
    ];
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
    const commandId = conflict.command.command_id;
    const persisted = byCommand.get(commandId);
    const outcome = volatileOutcomeInstances.has(conflict)
      ? conflict
      : persisted && sameOutcome(persisted, conflict) && persisted.dismissed
        ? { ...conflict, dismissed: true }
        : conflict;
    byCommand.delete(commandId);
    byCommand.set(commandId, outcome);
  }
  return [...byCommand.values()];
}

function sameOutcome(left: OfflineConflict, right: OfflineConflict): boolean {
  return (
    left.command.command_id === right.command.command_id &&
    left.command.client_id === right.command.client_id &&
    left.command.client_seq === right.command.client_seq &&
    left.kind === right.kind &&
    left.reason === right.reason &&
    left.recovery === right.recovery
  );
}

export function recordVolatileOutcome(
  projectPath: string,
  conflict: OfflineConflict,
): void {
  volatileOutcomeInstances.add(conflict);
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
  const next = { ...source.snapshot, ...patch };
  const selection = next.recoverySelection;
  if (
    selection &&
    !next.conflicts.some(
      (conflict) => conflict.dismissed && sameOutcome(conflict, selection),
    )
  ) {
    next.recoverySelection = null;
  }
  source.snapshot = next;
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

export function selectRecoveryOutcome(
  projectPath: string,
  outcome: OfflineConflict,
): boolean {
  const source = sources.get(projectPath);
  const current = source?.snapshot.conflicts.find(
    (conflict) => conflict.dismissed && sameOutcome(conflict, outcome),
  );
  if (!source || !current) return false;
  set(source, { recoverySelection: current });
  return true;
}

/** Clear the project's conflict list. A no-op unless the last read succeeded. */
export function dismissAllConflicts(projectPath: string): void {
  const source = sources.get(projectPath);
  if (!source || source.snapshot.status !== "ready") return;
  const clearing = ++source.generation;
  const captured = source.snapshot.conflicts.filter(
    (conflict) => !conflict.dismissed,
  );
  set(source, { status: "dismissing" });
  const token = shareTokenFromKey(projectPath);
  (token
    ? dismissConflicts(token, captured)
    : dismissHostConflicts(projectPath, captured)
  )
    .then((result) => {
      if (clearing === source.generation) {
        const currentVolatile = volatileOutcomes.get(projectPath) ?? [];
        const dismissedVolatile = currentVolatile.map((conflict) => {
          if (!captured.includes(conflict)) return conflict;
          const dismissed = { ...conflict, dismissed: true };
          volatileOutcomeInstances.add(dismissed);
          return dismissed;
        });
        if (dismissedVolatile.length) {
          volatileOutcomes.set(projectPath, dismissedVolatile);
        }
        set(source, {
          pending: result.pending,
          conflicts: withVolatileOutcomes(projectPath, result.conflicts),
          status: "ready",
        });
        if (source.snapshot.settling && !documentActivityBusy(projectPath)) {
          refresh(projectPath, source);
        }
      }
    })
    .catch(() => {
      if (clearing !== source.generation) return;
      const reading = ++source.generation;
      set(source, { status: "dismiss-failed" });
      read(projectPath)
        .then(([pending, conflicts]) => {
          if (reading !== source.generation) return;
          set(source, {
            pending,
            conflicts: withVolatileOutcomes(projectPath, conflicts),
            status: "dismiss-failed",
            loaded: true,
            settling: documentActivityBusy(projectPath),
          });
        })
        .catch(() => {
          if (reading === source.generation) {
            set(source, {
              status: "dismiss-failed",
              settling: documentActivityBusy(projectPath),
            });
          }
        });
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
