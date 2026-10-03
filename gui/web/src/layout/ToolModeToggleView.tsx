import type { ToolMode } from "../state/types";
import { Icon, SegmentedControl, ToggleButton } from "../ui";

export interface ToolModeToggleViewProps {
  compact?: boolean;
  structuralToolsAllowed: boolean;
  selectAllowed?: boolean;
  commentAllowed?: boolean;
  toolMode: ToolMode;
  commentMode: boolean;
  selectTitle: string;
  selectAriaKeyShortcuts?: string;
  bladeTitle: string;
  bladeAriaKeyShortcuts?: string;
  commentTitle: string;
  commentAriaKeyShortcuts?: string;
  onSelect: () => void;
  onBlade: () => void;
  onToggleComment: () => void;
}

/** Store-free Select / Blade (and Comment when not compact) tool cluster. */
export function ToolModeToggleView({
  compact = false,
  structuralToolsAllowed,
  selectAllowed = true,
  commentAllowed = true,
  toolMode,
  commentMode,
  selectTitle,
  selectAriaKeyShortcuts,
  bladeTitle,
  bladeAriaKeyShortcuts,
  commentTitle,
  commentAriaKeyShortcuts,
  onSelect,
  onBlade,
  onToggleComment,
}: ToolModeToggleViewProps) {
  const selectActive = toolMode === "select" && !commentMode;
  const bladeActive = toolMode === "blade" && !commentMode;

  return (
    <SegmentedControl
      label="Timeline tool"
      className={`tool-mode-toggle${compact ? " tool-mode-toggle--compact" : ""}`}
    >
      <>
        <ToggleButton
          quiet
          pressed={selectActive}
          disabled={!selectAllowed}
          title={selectAllowed ? selectTitle : "Open a project to select audio"}
          aria-label="Select"
          aria-keyshortcuts={selectAriaKeyShortcuts}
          onClick={onSelect}
        >
          <Icon name="select" />
        </ToggleButton>
        <ToggleButton
          quiet
          pressed={bladeActive}
          disabled={!structuralToolsAllowed}
          title={
            structuralToolsAllowed
              ? `${bladeTitle}: split at click or playhead`
              : "Blade requires permission to suggest edits"
          }
          aria-label="Blade"
          aria-keyshortcuts={bladeAriaKeyShortcuts}
          onClick={onBlade}
        >
          <Icon name="blade" />
        </ToggleButton>
      </>
      {!compact ? (
        <ToggleButton
          quiet
          pressed={commentMode}
          className="comment-mode-btn"
          disabled={!commentAllowed}
          title={
            commentAllowed ? commentTitle : "This share cannot add comments"
          }
          aria-label="Comment"
          aria-keyshortcuts={commentAriaKeyShortcuts}
          onClick={onToggleComment}
        >
          <Icon name="comment" />
        </ToggleButton>
      ) : null}
    </SegmentedControl>
  );
}
