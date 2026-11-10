import { type ComponentType, type RefObject, useRef } from "react";
import { commandLabel } from "../../commands/labels";
import { type CoachHint, CoachTip } from "../../system/CoachTip";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Icon, ToggleButton } from "../../ui";
import {
  AVAILABLE_VIEW_ANCHOR,
  useViewAnchor,
  type ViewAnchorAvailability,
} from "./useViewAnchor";
import type { ZoomAvailability } from "./useZoomControls";

export interface ViewPopoverSlotProps {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export interface EditCornerViewProps {
  viewAnchor?: ViewAnchorAvailability;
  zoom: ZoomAvailability;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  viewOpen: boolean;
  onToggleView: () => void;
  /** Closes the popover (a setter, never a toggle). */
  onCloseView: () => void;
  /** The eye popover, mounted while `viewOpen`; it hangs off the eye and closes through `onCloseView`. */
  viewPopover?: ComponentType<ViewPopoverSlotProps>;
  /** The Snap toggle, on every pointer: Alt inverts it for one gesture, and a finger has no Alt. */
  snap?: { on: boolean; reason?: string; onToggle: () => void };
  /** Phone has no side-by-side Script pane, so no toggle. */
  script?: { shown: boolean; onToggle: () => void };
  /**
   * The range bracket toggle, on touch devices only: a finger cannot drag on
   * empty lane, so arming it makes the next drag draw a range. Absent where a
   * mouse or pen drags a range directly.
   */
  range?: {
    armed: boolean;
    reason?: string;
    onToggle: () => void;
    hint?: CoachHint;
  };
}

const ZOOM_REASON = { in: "Fully zoomed in", out: "Fully zoomed out" } as const;

/** Snap, fit, zoom, the eye (View popover), the Script toggle and, on touch, the range toggle, bottom-right of the lanes. Snap leads so the eye keeps its place at the right edge. */
export function EditCornerView({
  viewAnchor = AVAILABLE_VIEW_ANCHOR,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  viewOpen,
  onToggleView,
  onCloseView,
  viewPopover: ViewPopoverSlot,
  snap,
  script,
  range,
}: EditCornerViewProps) {
  const eyeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useViewAnchor(viewOpen, viewAnchor, panelRef, onCloseView);
  return (
    <div className="edit-corner" role="group" aria-label="Timeline view">
      {snap ? (
        <ToggleButton
          quiet
          pressed={snap.on}
          className="edit-corner-btn edit-corner-snap"
          disabledReason={snap.reason}
          title={commandLabel("view.toggleSnap")}
          aria-label={commandLabel("view.toggleSnap")}
          onClick={snap.onToggle}
        >
          <Icon name="snap" />
        </ToggleButton>
      ) : null}
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
        ref={eyeRef}
        quiet
        pressed={viewOpen}
        className="edit-corner-btn edit-corner-eye"
        title="View options"
        aria-label="View options"
        aria-haspopup="dialog"
        aria-expanded={viewOpen}
        onClick={onToggleView}
      >
        <SystemIcon name="eye" size={20} />
      </ToggleButton>
      {viewOpen && ViewPopoverSlot ? (
        <ViewPopoverSlot
          anchorRef={eyeRef}
          panelRef={panelRef}
          onClose={onCloseView}
        />
      ) : null}
      {range ? (
        <CoachTip
          align="end"
          placement="above"
          text={range.hint?.text ?? ""}
          shown={range.hint?.shown ?? false}
          onDismiss={range.hint?.onDismiss}
        >
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
        </CoachTip>
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
