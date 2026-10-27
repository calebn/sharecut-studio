import type { ReactNode } from "react";
import { commandLabel } from "../../commands/labels";
import { Button, Icon, ToggleButton } from "../../ui";

export interface EditToolStripViewProps {
  /** Select, Blade and Comment mode; null when the person may use none of them. */
  toolToggle: ReactNode;
  rangeArmed: boolean;
  /** Why Select range cannot be used; omit when it can. */
  rangeReason?: string;
  rangeTitle: string;
  onToggleRange: () => void;
  /** Cut at the playhead, offered while the Blade tool is the active one. */
  showCut: boolean;
  cutTitle: string;
  onCut: () => void;
}

/**
 * Select / Blade, Comment mode and Range arm in the timeline corner.
 * #2294 removes this strip with Blade and the modes (Alt-click split, C for
 * Comment, the Action bar).
 */
export function EditToolStripView({
  toolToggle,
  rangeArmed,
  rangeReason,
  rangeTitle,
  onToggleRange,
  showCut,
  cutTitle,
  onCut,
}: EditToolStripViewProps) {
  return (
    <div className="edit-tool-strip" role="group" aria-label="Editing tools">
      {toolToggle}
      <ToggleButton
        quiet
        pressed={rangeArmed}
        className="edit-tool-strip-range"
        disabledReason={rangeReason}
        title={rangeTitle}
        aria-label={commandLabel("range.arm", "short")}
        onClick={onToggleRange}
      >
        <Icon name="range" />
      </ToggleButton>
      {showCut ? (
        <Button
          className="edit-tool-strip-cut"
          title={cutTitle}
          aria-label={commandLabel("edit.bladeCut")}
          onClick={onCut}
        >
          <Icon name="cutAtPlayhead" />
        </Button>
      ) : null}
    </div>
  );
}
