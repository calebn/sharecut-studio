import { execute } from "./execute";
import type { ExecuteResult } from "./types";

/**
 * Pointer/click dispatch: skips keyboard `when` gates, matching
 * CommandButton's default (`respectWhen = false`). Keyboard input goes
 * through the keymap listener, which respects `when`.
 */
export function runPointerCommand(
  id: string,
  args: Record<string, unknown> = {},
): void {
  void executePointerCommand(id, args);
}

/** Pointer dispatch for integrations that need completion or command status. */
export function executePointerCommand(
  id: string,
  args: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  return execute(id, args, { skipWhen: true });
}
