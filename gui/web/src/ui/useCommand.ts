import { useCallback } from "react";
import { COMMANDS } from "../commands/catalog";
import { buildCommandContext, evaluateWhen } from "../commands/context";
import { execute } from "../commands/execute";
import type { CommandDef, ExecuteResult } from "../commands/types";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";
import { memoByRef } from "../utils/memoByRef";

/**
 * `tracks.map(id).join(",")`, cached per `tracks` array. `useCommand`'s
 * selector runs on every store change (it must, to detect when-clause
 * inputs changing), so recomputing this join every time would scan every
 * track on every unrelated store update.
 */
const trackIdsKeyOf = memoByRef((tracks: readonly TrackView[]) =>
  tracks.map((track) => track.id).join(","),
);

export function trackIdsKey(tracks: readonly TrackView[] | undefined): string {
  return tracks ? trackIdsKeyOf(tracks) : "";
}

export type UseCommandResult = {
  def: CommandDef | undefined;
  label: string;
  /** The declared short form, or the full label when the command has none. */
  shortLabel: string;
  /** True when keyboard `when` would allow the command. */
  enabled: boolean;
  /** What is missing when `when` fails, for a disabled control; undefined when enabled. */
  whenReason: string | undefined;
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
      `${s.timelineFocused}|${s.stage}|${s.reviewSection}|${s.editSurface}|${s.scriptCollapsed}|${s.commentMode}|${s.projectPath}|${s.guestMode}|${s.selection?.kind ?? "none"}|${s.selection?.kind === "track" ? s.selection.trackId : ""}|${s.project != null}|${trackIdsKey(s.project?.tracks)}`,
  );

  const def = COMMANDS[commandId];
  const gate = def ? evaluateWhen(def.when, buildCommandContext()) : null;
  const enabled = gate?.ok ?? false;
  const whenReason = gate && !gate.ok ? gate.reason : undefined;

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
    shortLabel: def?.shortLabel ?? def?.label ?? commandId,
    enabled,
    whenReason,
    run,
  };
}
