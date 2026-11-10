import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useDawStore } from "../../state/dawStore";
import { useCoachTip } from "../../system/useCoachTip";
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
  const { scriptCollapsed, touch, rangeArmed, hasProject, snapEnabled } =
    useDawStore(
      useShallow((s) => ({
        scriptCollapsed: s.scriptCollapsed,
        touch: s.pointerKind === "coarse",
        rangeArmed: s.rangeArmed,
        hasProject: s.project != null,
        snapEnabled: s.snapEnabled,
      })),
    );
  const tip = useCoachTip("rangeToggle");
  // On a phone arming opens the docked Range sheet over the corner, so the tip would never be seen.
  const phone = useViewportClass() === "phone";
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
      snap={{
        on: snapEnabled,
        reason: hasProject ? undefined : "Open a project to change snapping",
        onToggle: () => runPointerCommand("view.toggleSnap"),
      }}
      range={
        touch
          ? {
              armed: rangeArmed,
              reason: hasProject
                ? undefined
                : "Open a project to select a range",
              hint: {
                text: tip.text,
                shown: tip.shown,
                onDismiss: tip.dismiss,
              },
              onToggle: () => {
                const wasArmed = rangeArmed;
                void executePointerCommand("range.arm").then((result) => {
                  if (result.status === "disabled" && !result.told)
                    useDawStore
                      .getState()
                      .announceStatus(result.reason, { tone: "error" });
                  else if (result.status === "ok" && !wasArmed && !phone)
                    tip.show();
                });
              },
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
