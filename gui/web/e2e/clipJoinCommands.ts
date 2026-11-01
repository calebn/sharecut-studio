import { isDeepStrictEqual } from "node:util";

export type CommandAttempt = Record<string, unknown>;

export function logicalClipJoinCommands(
  attempts: readonly CommandAttempt[],
): CommandAttempt[] {
  const commands = new Map<string, CommandAttempt>();
  for (const attempt of attempts) {
    if (attempt.type !== "SetClipJoin") continue;
    const { command_id, client_id, client_seq } = attempt;
    if (
      typeof command_id !== "string" ||
      command_id.length === 0 ||
      typeof client_id !== "string" ||
      client_id.length === 0 ||
      typeof client_seq !== "number" ||
      !Number.isSafeInteger(client_seq) ||
      client_seq <= 0
    )
      throw new Error("Invalid SetClipJoin command identity");
    const previous = commands.get(command_id);
    if (previous && !isDeepStrictEqual(previous, attempt))
      throw new Error("SetClipJoin replay changed its envelope");
    commands.set(command_id, attempt);
  }
  return [...commands.values()];
}
