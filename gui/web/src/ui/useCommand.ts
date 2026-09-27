import { useCallback } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import type { CommandDef, ExecuteResult } from "../commands/types";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";

/**
 * `tracks.map(id).join(",")`, cached per `tracks` array. `useCommand`'s
 * selector runs on every store change (it must, to detect when-clause
 * inputs changing), so recomputing this join every time would scan every
 * track on every unrelated store update.
 */
const trackIdsKeyCache = new WeakMap<readonly TrackView[], string>();

export function trackIdsKey(tracks: readonly TrackView[] | undefined): string {
  if (!tracks) {
    return "";
  }
  const cached = trackIdsKeyCache.get(tracks);
  if (cached !== undefined) {
    return cached;
  }
  const key = tracks.map((track) => track.id).join(",");
  trackIdsKeyCache.set(tracks, key);
  return key;
}

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
      `${s.timelineFocused}|${s.activeTab}|${s.commentMode}|${s.projectPath}|${s.guestMode}|${s.selection?.kind ?? "none"}|${s.selection?.kind === "track" ? s.selection.trackId : ""}|${s.project != null}|${trackIdsKey(s.project?.tracks)}`,
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
