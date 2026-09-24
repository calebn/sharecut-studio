/** Frontend UX command ids — not SyncCommand / DocumentCommand wire types. */

export type CommandCategory =
  | "transport"
  | "tools"
  | "focus"
  | "navigation"
  | "review"
  | "edit"
  | "history"
  | "view"
  | "ui"
  | "presence";

/** Typed when-clause predicates (no string DSL in Phase 1). */
export type ContextPredicateId =
  | "always"
  | "layoutFocused"
  | "timelineFocused"
  | "commentMode"
  | "canSuggestStructural"
  | "timelineAndStructural"
  | "hasProject"
  | "canApplyPass12"
  | "canRefreshMix"
  | "canIngestMedia"
  | "canManageProjects"
  | "hostProjectLoaded"
  | "trackInspectorSelected"
  | "canMoveSelectedTrackUp"
  | "canMoveSelectedTrackDown"
  | "hasInspectorSelection"
  | "following"
  | "recordPanelOpen"
  | "tightenPanelOpen";

export type ExecuteResult =
  | { status: "ok" }
  | { status: "disabled"; reason: string }
  | { status: "unknown" };

export type CommandHandler = (
  args: Record<string, unknown>,
  ctx: import("./context").CommandContext,
) => ExecuteResult | Promise<ExecuteResult>;

export type CommandDef = {
  id: string;
  category: CommandCategory;
  label: string;
  /** Default when-clause when invoked via keyboard; buttons may bypass. */
  when: ContextPredicateId;
  notes?: string;
  /** False for commands that require context-specific arguments from a caller. */
  paletteRunnable?: false;
  /** Strong local navigation: stop following after a successful run. */
  breaksFollow?: true;
};
