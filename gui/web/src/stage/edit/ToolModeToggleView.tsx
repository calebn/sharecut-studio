import { commandLabel } from "../../commands/labels";
import type { ToolMode } from "../../state/types";
import { Icon, SegmentedControl, ToggleButton } from "../../ui";

export interface ToolModeToggleViewProps {
  compact?: boolean;
  /** Why each tool is unavailable; omit when it can be used. */
  selectReason?: string;
  bladeReason?: string;
  commentReason?: string;
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
  selectReason,
  bladeReason,
  commentReason,
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
          disabledReason={selectReason}
          title={selectTitle}
          aria-label={commandLabel("tool.select")}
          aria-keyshortcuts={selectAriaKeyShortcuts}
          onClick={onSelect}
        >
          <Icon name="select" />
        </ToggleButton>
        <ToggleButton
          quiet
          pressed={bladeActive}
          disabledReason={bladeReason}
          title={`${bladeTitle}: split at click or playhead`}
          aria-label={commandLabel("tool.blade")}
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
          disabledReason={commentReason}
          title={commentTitle}
          aria-label={commandLabel("review.toggleCommentMode")}
          aria-keyshortcuts={commentAriaKeyShortcuts}
          onClick={onToggleComment}
        >
          <Icon name="comment" />
        </ToggleButton>
      ) : null}
    </SegmentedControl>
  );
}
