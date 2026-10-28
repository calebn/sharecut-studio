import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import { EditCornerView } from "./EditCornerView";
import { useZoomControls } from "./useZoomControls";

export function EditCorner({ showScript = true }: { showScript?: boolean }) {
  const { zoom, onZoomIn, onZoomOut } = useZoomControls();
  const {
    openSheet,
    setOpenSheet,
    scriptCollapsed,
    touch,
    rangeArmed,
    hasProject,
  } = useDawStore(
    useShallow((s) => ({
      openSheet: s.openSheet,
      setOpenSheet: s.setOpenSheet,
      scriptCollapsed: s.scriptCollapsed,
      touch: s.pointerKind === "coarse",
      rangeArmed: s.rangeArmed,
      hasProject: s.project != null,
    })),
  );
  return (
    <EditCornerView
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onFit={() => runPointerCommand("view.fit")}
      viewOpen={openSheet === "view"}
      onToggleView={() => setOpenSheet(openSheet === "view" ? null : "view")}
      range={
        touch
          ? {
              armed: rangeArmed,
              reason: hasProject
                ? undefined
                : "Open a project to select a range",
              onToggle: () => runPointerCommand("range.arm"),
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
