import type { ToolMode } from "../state/types";
import { Icon, SegmentedControl, ToggleButton } from "../ui";

export interface ToolModeToggleViewProps {
  compact?: boolean;
  structuralToolsAllowed: boolean;
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
      {structuralToolsAllowed ? (
        <>
          <ToggleButton
            quiet
            pressed={selectActive}
            title={selectTitle}
            aria-label="Select"
            aria-keyshortcuts={selectAriaKeyShortcuts}
            onClick={onSelect}
          >
            <Icon name="select" />
          </ToggleButton>
          <ToggleButton
            quiet
            pressed={bladeActive}
            title={`${bladeTitle}: split at click or playhead`}
            aria-label="Blade"
            aria-keyshortcuts={bladeAriaKeyShortcuts}
            onClick={onBlade}
          >
            <Icon name="blade" />
          </ToggleButton>
        </>
      ) : null}
      {!compact ? (
        <ToggleButton
          quiet
          pressed={commentMode}
          className="comment-mode-btn"
          title={commentTitle}
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
