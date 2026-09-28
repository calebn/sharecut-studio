import { execute } from "./execute";

/**
 * Pointer/click dispatch: skips keyboard `when` gates, matching
 * CommandButton's default (`respectWhen = false`). Keyboard input goes
 * through the keymap listener, which respects `when`.
 */
export function runPointerCommand(
  id: string,
  args: Record<string, unknown> = {},
): void {
  void execute(id, args, { skipWhen: true });
}
