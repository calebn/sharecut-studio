import { useSyncExternalStore } from "react";
import type { HistoryEntryId } from "../types/project";

/**
 * An Undo or Redo pressed while this tab's own edit is still saving. The press
 * is held, not lost: it runs when the saves settle, and the server refuses it
 * (`history_stale`) if the step it meant is no longer the newest. This record
 * is what every Undo surface (toast, Mod+Z, header, gesture) reads to tell the
 * person what is happening, so no surface keeps its own flag.
 */
export type QueuedMoveState =
  | { readonly kind: "waiting" }
  | { readonly kind: "fired" }
  | { readonly kind: "dropped"; readonly reason: string };

export interface QueuedMove {
  readonly action: "undo" | "redo";
  /** The history step the press meant (a toast's entry); null means the newest step. */
  readonly target: HistoryEntryId | null;
  readonly state: QueuedMoveState;
}

export interface QueuedMoveHandle {
  /** The request is going out. Only a waiting move can fire. */
  fire: () => void;
  /** The move will not run; `reason` is the plain-words cause that was announced. */
  drop: (reason: string) => void;
}

const COPY = {
  undo: { ready: "Undo ready after save", queued: "Undo runs after save" },
  redo: { ready: "Redo ready after save", queued: "Redo runs after save" },
} as const;

/** What a control says while a save runs and a press would wait. */
export function readyAfterSaveCopy(action: "undo" | "redo"): string {
  return COPY[action].ready;
}

/** What a press says once it is waiting for the save. */
export function runsAfterSaveCopy(action: "undo" | "redo"): string {
  return COPY[action].queued;
}

const moves = new Map<string, QueuedMove>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` whenever a queued move begins or settles for any project. */
export function subscribeQueuedMove(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest move queued for the project, in any state; null if none. */
export function queuedMoveOf(projectPath: string): QueuedMove | null {
  return moves.get(projectPath) ?? null;
}

/** Records a press that is waiting for saves to settle. A newer press replaces the record. */
export function queueMove(
  projectPath: string,
  action: "undo" | "redo",
  target: HistoryEntryId | null,
): QueuedMoveHandle {
  let current: QueuedMove = { action, target, state: { kind: "waiting" } };
  moves.set(projectPath, current);
  notify();
  const settle = (state: QueuedMoveState) => {
    if (current.state.kind !== "waiting" || moves.get(projectPath) !== current)
      return;
    current = { ...current, state };
    moves.set(projectPath, current);
    notify();
  };
  return {
    fire: () => settle({ kind: "fired" }),
    drop: (reason) => settle({ kind: "dropped", reason }),
  };
}

/** The move waiting for saves in this project, or null. Re-renders on change. */
export function useWaitingMove(projectPath: string): QueuedMove | null {
  const move = useSyncExternalStore(subscribeQueuedMove, () =>
    queuedMoveOf(projectPath),
  );
  return move?.state.kind === "waiting" ? move : null;
}

export function _resetQueuedMovesForTests(): void {
  moves.clear();
  notify();
}
