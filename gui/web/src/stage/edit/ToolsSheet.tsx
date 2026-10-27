import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { canEditMix } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import { EditCorner } from "./EditCorner";
import { EditToolStrip } from "./EditToolStrip";
import { EditSurfaceSwitch } from "./PhoneEditSurfaceView";

/**
 * The Edit controls behind the header's Tools button, for a frame too short for
 * their rows: on a phone the Timeline and Script switch and the tools, then the
 * corner (zoom, the eye, the Script toggle, which a short frame takes off the
 * lanes) and Mix.
 */
export function ToolsSheet() {
  const { surface, setOpenSheet, mixAllowed } = useDawStore(
    useShallow((s) => ({
      surface: s.editSurface,
      setOpenSheet: s.setOpenSheet,
      mixAllowed: canEditMix(s.projectPath, s.guestMode, s.shareCapabilities),
    })),
  );
  const phone = useViewportClass() === "phone";
  return (
    <div className="tools-sheet">
      {phone ? (
        <EditSurfaceSwitch
          surface={surface}
          onSurfaceChange={(next) =>
            runPointerCommand("stage.edit", { surface: next })
          }
        />
      ) : null}
      {phone && surface === "lanes" ? <EditToolStrip /> : null}
      {surface === "lanes" || !phone ? (
        <EditCorner showScript={!phone} />
      ) : null}
      {mixAllowed ? (
        <Button title="Mix" onClick={() => setOpenSheet("mix")}>
          <SystemIcon name="sliders-horizontal" size={20} />
          Mix
        </Button>
      ) : null}
    </div>
  );
}
