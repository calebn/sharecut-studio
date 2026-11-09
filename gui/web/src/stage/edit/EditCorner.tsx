import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import { EditCornerView } from "./EditCornerView";
import type { ViewAnchorAvailability } from "./useViewAnchor";
import { useZoomControls } from "./useZoomControls";
import { ViewPopover } from "./ViewPopover";

export function EditCorner({
  showScript = true,
  viewAnchor,
}: {
  showScript?: boolean;
  viewAnchor?: ViewAnchorAvailability;
}) {
  const { zoom, onZoomIn, onZoomOut } = useZoomControls();
  const [viewOpen, setViewOpen] = useState(false);
  const { scriptCollapsed, touch, rangeArmed, hasProject } = useDawStore(
    useShallow((s) => ({
      scriptCollapsed: s.scriptCollapsed,
      touch: s.pointerKind === "coarse",
      rangeArmed: s.rangeArmed,
      hasProject: s.project != null,
    })),
  );
  return (
    <EditCornerView
      viewAnchor={viewAnchor}
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onFit={() => runPointerCommand("view.fit")}
      viewOpen={viewOpen}
      onToggleView={() => setViewOpen((open) => !open)}
      onCloseView={() => setViewOpen(false)}
      viewPopover={ViewPopover}
      range={
        touch
          ? {
              armed: rangeArmed,
              reason: hasProject
                ? undefined
                : "Open a project to select a range",
              onToggle: () =>
                void executePointerCommand("range.arm").then((result) => {
                  if (result.status === "disabled" && !result.told)
                    useDawStore
                      .getState()
                      .announceStatus(result.reason, { tone: "error" });
                }),
            }
          : undefined
      }
      script={
        showScript
          ? {
              shown: !scriptCollapsed,
              onToggle: () => runPointerCommand("view.toggleScript"),
            }
          : undefined
      }
    />
  );
}
