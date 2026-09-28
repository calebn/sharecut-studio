import { runPointerCommand } from "../commands/pointer";
import { ariaKeyShortcutsFor, titleWithShortcut } from "../keymap/registry";
import { canSuggestStructuralOnProject } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { commentModeTitle } from "./commentModeTitle";
import { ToolModeToggleView } from "./ToolModeToggleView";

/** Select / Blade (and Comment when not compact) tool cluster. */
export function ToolModeToggle({ compact = false }: { compact?: boolean }) {
  const {
    toolMode,
    commentMode,
    project,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    toolMode: s.toolMode,
    commentMode: s.commentMode,
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const allowed = canSuggestStructuralOnProject(
    projectPath,
    guestMode,
    shareCapabilities,
    project != null,
  );

  return (
    <ToolModeToggleView
      compact={compact}
      structuralToolsAllowed={allowed}
      toolMode={toolMode}
      commentMode={commentMode}
      selectTitle={titleWithShortcut("Select tool", "tool.select")}
      selectAriaKeyShortcuts={ariaKeyShortcutsFor("tool.select")}
      bladeTitle={titleWithShortcut("Blade tool", "tool.blade")}
      bladeAriaKeyShortcuts={ariaKeyShortcutsFor("tool.blade")}
      commentTitle={commentModeTitle}
      commentAriaKeyShortcuts={ariaKeyShortcutsFor("review.toggleCommentMode")}
      onSelect={() => runPointerCommand("tool.select")}
      onBlade={() => runPointerCommand("tool.blade")}
      onToggleComment={() => runPointerCommand("review.toggleCommentMode")}
    />
  );
}
