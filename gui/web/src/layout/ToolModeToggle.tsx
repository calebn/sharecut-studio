import { runPointerCommand } from "../commands/pointer";
import { formatShortcutKeys, keymapCommandById } from "../keymap/registry";
import { canSuggestStructuralOnProject } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { ToolModeToggleView } from "./ToolModeToggleView";

function toolTitle(commandId: string, fallback: string): string {
  const cmd = keymapCommandById(commandId);
  if (!cmd) {
    return fallback;
  }
  return `${cmd.label} (${formatShortcutKeys(cmd)})`;
}

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
      selectTitle={toolTitle("tool.select", "Select tool")}
      bladeTitle={toolTitle("tool.blade", "Blade tool")}
      onSelect={() => runPointerCommand("tool.select")}
      onBlade={() => runPointerCommand("tool.blade")}
      onToggleComment={() => runPointerCommand("review.toggleCommentMode")}
    />
  );
}
