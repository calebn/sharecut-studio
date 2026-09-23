import { useCallback } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import type { CommandDef, ExecuteResult } from "../commands/types";
import { useDawStore } from "../state/dawStore";

export type UseCommandResult = {
  def: CommandDef | undefined;
  label: string;
  /** True when keyboard `when` would allow the command. */
  enabled: boolean;
  run: (
    args?: Record<string, unknown>,
    options?: { skipWhen?: boolean },
  ) => Promise<ExecuteResult>;
};

/**
 * Catalog + execute bridge for chrome. Does not attach key listeners.
 * Subscribes via a stable string key (not `project` object identity) so poll
 * refreshes cannot trip React's getSnapshot infinite-loop guard.
 */
export function useCommand(commandId: string): UseCommandResult {
  // Stable primitive — reading it re-renders when when-clause inputs change.
  useDawStore(
    (s) =>
      `${s.timelineFocused}|${s.activeTab}|${s.commentMode}|${s.projectPath}|${s.guestMode}|${s.selection?.kind ?? "none"}|${s.selection?.kind === "track" ? s.selection.trackId : ""}|${s.project != null}|${s.project?.tracks.map((track) => track.id).join(",") ?? ""}`,
  );

  const def = COMMANDS[commandId];
  const enabled = def
    ? evaluateWhen(def.when, buildCommandContext()).ok
    : false;

  const run = useCallback(
    (args: Record<string, unknown> = {}, options?: { skipWhen?: boolean }) =>
      execute(commandId, args, {
        skipWhen: options?.skipWhen ?? true,
      }),
    [commandId],
  );

  return {
    def,
    label: def?.label ?? commandId,
    enabled,
    run,
  };
}
