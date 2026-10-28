import { commandLabel } from "../../commands/labels";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Icon, ToggleButton } from "../../ui";
import type { ZoomAvailability } from "./useZoomControls";

export interface EditCornerViewProps {
  zoom: ZoomAvailability;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  viewOpen: boolean;
  onToggleView: () => void;
  /** Phone has no side-by-side Script pane, so no toggle. */
  script?: { shown: boolean; onToggle: () => void };
  /**
   * The range bracket toggle, on touch devices only: a finger cannot drag on
   * empty lane, so arming it makes the next drag draw a range. Absent where a
   * mouse or pen drags a range directly.
   */
  range?: { armed: boolean; reason?: string; onToggle: () => void };
}

const ZOOM_REASON = { in: "Fully zoomed in", out: "Fully zoomed out" } as const;

/** Fit, zoom, the eye (View sheet), the Script toggle and, on touch, the range toggle, bottom-right of the lanes. */
export function EditCornerView({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  viewOpen,
  onToggleView,
  script,
  range,
}: EditCornerViewProps) {
  return (
    <div className="edit-corner" role="group" aria-label="Timeline view">
      <Button
        className="edit-corner-btn"
        title={commandLabel("view.fit")}
        aria-label={commandLabel("view.fit")}
        onClick={onFit}
      >
        <Icon name="fit" />
      </Button>
      <Button
        className="edit-corner-btn"
        title={commandLabel("view.zoomOut")}
        aria-label={commandLabel("view.zoomOut")}
        disabledReason={zoom.canZoomOut ? undefined : ZOOM_REASON.out}
        onClick={onZoomOut}
      >
        <Icon name="zoomOut" />
      </Button>
      <Button
        className="edit-corner-btn"
        title={commandLabel("view.zoomIn")}
        aria-label={commandLabel("view.zoomIn")}
        disabledReason={zoom.canZoomIn ? undefined : ZOOM_REASON.in}
        onClick={onZoomIn}
      >
        <Icon name="zoomIn" />
      </Button>
      <ToggleButton
        quiet
        pressed={viewOpen}
        className="edit-corner-btn edit-corner-eye"
        title="View options"
        aria-label="View options"
        aria-haspopup="dialog"
        onClick={onToggleView}
      >
        <SystemIcon name="eye" size={20} />
      </ToggleButton>
      {range ? (
        <ToggleButton
          quiet
          pressed={range.armed}
          className="edit-corner-btn edit-corner-range"
          disabledReason={range.reason}
          title={commandLabel("range.arm")}
          aria-label={commandLabel("range.arm", "short")}
          onClick={range.onToggle}
        >
          <Icon name="range" />
        </ToggleButton>
      ) : null}
      {script ? (
        <ToggleButton
          quiet
          pressed={script.shown}
          className="edit-corner-btn edit-corner-script"
          title={commandLabel("view.toggleScript")}
          aria-label={commandLabel("view.toggleScript")}
          onClick={script.onToggle}
        >
          Script
        </ToggleButton>
      ) : null}
    </div>
  );
}
