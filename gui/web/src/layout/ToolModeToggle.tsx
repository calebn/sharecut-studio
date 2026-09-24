import { formatShortcutKeys, keymapCommandById } from "../keymap/registry";
import { canSuggestStructuralOnProject } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { CommandButton, Icon, SegmentedControl } from "../ui";

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
  } = useDaw();
  const allowed = canSuggestStructuralOnProject(
    projectPath,
    guestMode,
    shareCapabilities,
    project != null,
  );
  const selectActive = toolMode === "select" && !commentMode;
  const bladeActive = toolMode === "blade" && !commentMode;

  return (
    <SegmentedControl
      label="Timeline tool"
      className={`tool-mode-toggle${compact ? " tool-mode-toggle--compact" : ""}`}
    >
      {allowed ? (
        <>
          <CommandButton
            bare
            commandId="tool.select"
            className={`ui-control--quiet${selectActive ? " active" : ""}`}
            aria-pressed={selectActive}
            title={toolTitle("tool.select", "Select tool")}
            aria-label="Select"
          >
            <Icon name="select" />
          </CommandButton>
          <CommandButton
            bare
            commandId="tool.blade"
            className={`ui-control--quiet${bladeActive ? " active" : ""}`}
            aria-pressed={bladeActive}
            title={`${toolTitle("tool.blade", "Blade tool")}: split at click or playhead`}
            aria-label="Blade"
          >
            <Icon name="blade" />
          </CommandButton>
        </>
      ) : null}
      {!compact ? (
        <CommandButton
          bare
          commandId="review.toggleCommentMode"
          className={`ui-control--quiet comment-mode-btn${commentMode ? " active" : ""}`}
          aria-pressed={commentMode}
          title="Comment mode: click/drag ruler to anchor feedback"
          aria-label="Comment"
        >
          <Icon name="comment" />
        </CommandButton>
      ) : null}
    </SegmentedControl>
  );
}
