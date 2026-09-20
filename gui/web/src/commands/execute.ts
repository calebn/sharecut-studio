import { isProgrammaticUi } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { COMMANDS } from "./catalog";
import {
  buildCommandContext,
  type CommandContext,
  evaluateWhen,
} from "./context";
import type { CommandHandler, ExecuteResult } from "./types";

const handlers = new Map<string, CommandHandler>();

export function registerCommand(id: string, handler: CommandHandler): void {
  handlers.set(id, handler);
}

export function listRegisteredIds(): string[] {
  return [...handlers.keys()].sort();
}

export function clearRegisteredCommands(): void {
  handlers.clear();
}

/**
 * Run a UX command by stable id.
 * @param skipWhen When true (button click), skip keyboard when-clauses.
 */
export async function execute(
  id: string,
  args: Record<string, unknown> = {},
  options?: { ctx?: CommandContext; skipWhen?: boolean },
): Promise<ExecuteResult> {
  const def = COMMANDS[id];
  if (!def) {
    return { status: "unknown" };
  }
  const handler = handlers.get(id);
  if (!handler) {
    return { status: "unknown" };
  }
  const ctx = options?.ctx ?? buildCommandContext();
  if (!options?.skipWhen) {
    const gate = evaluateWhen(def.when, ctx);
    if (!gate.ok) {
      return { status: "disabled", reason: gate.reason };
    }
  }
  const result = await handler(args, ctx);
  if (def.breaksFollow && result.status === "ok" && !isProgrammaticUi()) {
    useDawStore.getState().stopFollow("local");
  }
  return result;
}
