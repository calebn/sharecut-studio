import { redoHistory, undoHistory } from "../api";
import { registerCommand } from "./execute";
import { flushPendingMix } from "./trackMix";

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
