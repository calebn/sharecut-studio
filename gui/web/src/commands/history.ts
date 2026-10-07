import { redoHistory, undoHistory } from "../api";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import { execute, registerCommand } from "./execute";
import { flushPendingMix } from "./trackMix";
import type { ExecuteResult } from "./types";

export function registerHistoryCommands(): void {
  registerCommand("history.undo", async (_args, ctx) => {
    await flushPendingMix();
    await undoHistory(ctx.projectPath);
    return { status: "ok" };
  });

  registerCommand("history.redo", async (_args, ctx) => {
    await flushPendingMix();
    await redoHistory(ctx.projectPath);
    return { status: "ok" };
  });
}

const HISTORY_LABEL = { undo: "Undo", redo: "Redo" } as const;

/**
 * Runs Undo or Redo from a control or gesture. A failure is announced
 * ("Undo failed: …"), never dropped. `dispatch` is `execute` (keyboard-style
 * gates) unless the caller passes the pointer bridge.
 */
export function runHistoryAction(
  action: keyof typeof HISTORY_LABEL,
  dispatch: (id: string) => Promise<ExecuteResult> = (id) => execute(id),
): void {
  const report = (reason: string) =>
    useDawStore
      .getState()
      .announceStatus(`${HISTORY_LABEL[action]} failed: ${reason}`);
  void dispatch(`history.${action}`)
    .then((result) => {
      if (result.status !== "ok")
        report("reason" in result ? result.reason : "unavailable");
    })
    .catch((error: unknown) => report(errorMessage(error)));
}
