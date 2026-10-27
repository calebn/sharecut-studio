/** Frontend UX command ids — not SyncCommand / DocumentCommand wire types. */

export type CommandCategory =
  | "transport"
  | "tools"
  | "navigation"
  | "review"
  | "edit"
  | "history"
  | "view"
  | "ui"
  | "presence";

/** Typed when-clause predicates (no string DSL in Phase 1). */
export type ContextPredicateId =
  | "focusedFadeHandle"
  | "focusedTrimHandle"
  | "always"
  | "editorFocused"
  | "timelineFocused"
  | "commentMode"
  | "canSuggestStructural"
  | "timelineAndStructural"
  | "hasProject"
  | "canApplyPass12"
  | "canRefreshMix"
  | "canIngestMedia"
  | "canEditMix"
  | "canEditEnvelopes"
  | "canComment"
  | "canManageProjects"
  | "hostProjectLoaded"
  | "trackInspectorSelected"
  | "canMoveSelectedTrackUp"
  | "canMoveSelectedTrackDown"
  | "canSplitSpeakers"
  | "hasInspectorSelection"
  | "following"
  | "recordPanelOpen"
  | "tightenPanelOpen"
  | "canUndo"
  | "canRedo";

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
  /** The visible name on every surface: button, menu item, palette row, manifest. */
  label: string;
  /**
   * The one short form for a narrow control (a row of chips, a word bar).
   * Declared here once; a control never types its own abbreviation.
   */
  shortLabel?: string;
  /**
   * Other names one control takes for this command when its state or target
   * changes (Ignore turns into Restore, Undo into Undo timing). Declared here
   * once; the label-parity test accepts no other literal.
   */
  variants?: readonly string[];
  /**
   * Extra lowercase words the command palette matches, for what people type
   * instead of the label (file types, synonyms).
   */
  keywords?: readonly string[];
  /** Default when-clause when invoked via keyboard; buttons may bypass. */
  when: ContextPredicateId;
  notes?: string;
  /**
   * The command writes the document or a comment. `commands/undoToast.test.ts`
   * walks these: each one raises a toast whose Undo reverses it, or says why
   * its result needs no toast.
   */
  mutates?: true;
  /** False for commands that require context-specific arguments from a caller. */
  paletteRunnable?: false;
  /** Strong local navigation: stop following after a successful run. */
  breaksFollow?: true;
};
