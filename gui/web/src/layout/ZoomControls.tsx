import { useId } from "react";
import { commandLabel } from "../commands/labels";
import type { ZoomAvailability } from "../stage/edit/useZoomControls";
import { Button, Icon } from "../ui";

const ZOOM_COPY = {
  in: {
    label: commandLabel("view.zoomIn"),
    reason: "Fully zoomed in",
    icon: "zoomIn",
  },
  out: {
    label: commandLabel("view.zoomOut"),
    reason: "Fully zoomed out",
    icon: "zoomOut",
  },
} as const;

export function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
}: {
  zoom: ZoomAvailability;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  return (
    <div className="editing-tool-rail-zoom" role="group" aria-label="Zoom">
      <ZoomButton
        direction="out"
        available={zoom.canZoomOut}
        onClick={onZoomOut}
      />
      <ZoomButton
        direction="in"
        available={zoom.canZoomIn}
        onClick={onZoomIn}
      />
    </div>
  );
}

function ZoomButton({
  direction,
  available,
  onClick,
}: {
  direction: "in" | "out";
  available: boolean;
  onClick: () => void;
}) {
  const reasonId = useId();
  const { label, reason, icon } = ZOOM_COPY[direction];
  return (
    <Button
      className="editing-tool-rail-icon"
      aria-label={label}
      title={available ? label : reason}
      aria-disabled={available ? undefined : true}
      aria-describedby={available ? undefined : reasonId}
      onClick={available ? onClick : undefined}
    >
      <Icon name={icon} size={20} />
      {available ? null : (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </Button>
  );
}
