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

/**
 * Undo or redo, guarded by the latest history entry the caller saw. A toast
 * passes its own change (`expectedHeadId`); Mod+Z, the History tab and other
 * callers send the head this tab shows after flushing its pending mix edits.
 * Either way the server refuses (`history_stale`) instead of reverting an
 * edit that landed after the caller looked.
 */
async function moveHistory(
  action: "undo" | "redo",
  projectPath: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  await flushPendingMix();
  const expectedHeadId: HistoryEntryId | null =
    parseHistoryEntryId(args.expectedHeadId) ??
    useDawStore.getState().project?.history.head_id ??
    null;
  try {
    await (action === "undo" ? undoHistory : redoHistory)(projectPath, {
      expectedHeadId,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === HISTORY_STALE_CODE) {
      useDawStore.getState().announceStatus(STALE_COPY[action]);
      return { status: "disabled", reason: STALE_COPY[action] };
    }
    throw e;
  }
  return { status: "ok" };
}

export function registerHistoryCommands(): void {
  registerCommand("history.undo", (args, ctx) =>
    moveHistory("undo", ctx.projectPath, args),
  );
  registerCommand("history.redo", (args, ctx) =>
    moveHistory("redo", ctx.projectPath, args),
  );
}
