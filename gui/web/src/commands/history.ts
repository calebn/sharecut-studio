import { HISTORY_STALE_CODE, redoHistory, undoHistory } from "../api";
import { useDawStore } from "../state/dawStore";
import { type HistoryEntryId, parseHistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { registerCommand } from "./execute";
import { flushPendingMix } from "./trackMix";
import type { ExecuteResult } from "./types";

const STALE_COPY = {
  undo: "Can't undo: the project changed since. Nothing was undone.",
  redo: "Can't redo: the project changed since. Nothing was redone.",
} as const;

const NO_HEAD = "Open a project first.";

/**
 * This tab's own undo/redo moves (Mod+Z, Mod+Shift+Z, the History tab, the
 * toast Undo, the phone two-finger tap). They run one at a time: a press made
 * while an earlier one is in flight waits for its reply and expects the head
 * that reply returned. The tab's own undo moved the head; that is not someone
 * else's change, so it must not make the next press stale.
 */
const moves: {
  /** The last queued move; settles with the head it left (null: none). */
  tail: {
    projectPath: string;
    landed: Promise<HistoryEntryId | null>;
  } | null;
  /** The tab's last own move that landed: where it started and ended. */
  last: {
    projectPath: string;
    from: HistoryEntryId;
    to: HistoryEntryId;
  } | null;
} = { tail: null, last: null };

/**
 * The latest head this tab knows: the one it shows, unless it still shows
 * where its own last move started because the reply arrived before the update.
 */
function knownHead(projectPath: string): HistoryEntryId | null {
  const shown = useDawStore.getState().project?.history.head_id ?? null;
  const last = moves.last;
  return last?.projectPath === projectPath && shown === last.from
    ? last.to
    : shown;
}

/**
 * Undo or redo, guarded by the history head the person saw. A toast passes its
 * own change (`expectedHeadId`); other callers send the head this tab knows,
 * read after flushing its pending mix edits, or, behind an earlier move of
 * this tab, the head that move landed on. A peer edit that arrives while a
 * press waits its turn is never adopted: the server refuses (`history_stale`)
 * instead of reverting an edit the person had not seen.
 */
function moveHistory(
  action: "undo" | "redo",
  projectPath: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const explicit = parseHistoryEntryId(args.expectedHeadId);
  const ahead =
    moves.tail?.projectPath === projectPath ? moves.tail.landed : null;
  const knownAtPress = knownHead(projectPath);
  let settle: (landed: HistoryEntryId | null) => void = () => {};
  const tail = {
    projectPath,
    landed: new Promise<HistoryEntryId | null>((resolve) => {
      settle = resolve;
    }),
  };
  moves.tail = tail;

  const run = async (): Promise<ExecuteResult> => {
    let landed: HistoryEntryId | null = null;
    try {
      const aheadLanded = ahead ? await ahead : null;
      await flushPendingMix();
      const expectedHeadId =
        explicit ??
        (ahead ? (aheadLanded ?? knownAtPress) : knownHead(projectPath));
      if (expectedHeadId === null) {
        return { status: "disabled", reason: NO_HEAD };
      }
      try {
        landed = await (action === "undo" ? undoHistory : redoHistory)(
          projectPath,
          { expectedHeadId },
        );
      } catch (e) {
        if (e instanceof ApiError && e.code === HISTORY_STALE_CODE) {
          useDawStore.getState().announceStatus(STALE_COPY[action]);
          return {
            status: "disabled",
            reason: STALE_COPY[action],
            announced: true,
          };
        }
        throw e;
      }
      if (landed !== null) {
        moves.last = { projectPath, from: expectedHeadId, to: landed };
      }
      return { status: "ok" };
    } finally {
      if (moves.tail === tail) moves.tail = null;
      settle(landed);
    }
  };
  return run();
}

/** Tests only: forget queued and landed moves. */
export function _resetHistoryMovesForTests(): void {
  moves.tail = null;
  moves.last = null;
}

export function registerHistoryCommands(): void {
  registerCommand("history.undo", (args, ctx) =>
    moveHistory("undo", ctx.projectPath, args),
  );
  registerCommand("history.redo", (args, ctx) =>
    moveHistory("redo", ctx.projectPath, args),
  );
}
