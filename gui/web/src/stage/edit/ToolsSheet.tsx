import { useShallow } from "zustand/react/shallow";
import { canEditMix } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import { EditToolStrip } from "./EditToolStrip";
import { EditSurfaceSwitch } from "./PhoneEditSurfaceView";

/**
 * The phone's Edit controls behind the header's Tools button, for a window too
 * short for their two rows: the Timeline and Script switch, the tools and Mix.
 */
export function ToolsSheet() {
  const { surface, setSurface, setOpenSheet, mixAllowed } = useDawStore(
    useShallow((s) => ({
      surface: s.editSurface,
      setSurface: s.setEditSurface,
      setOpenSheet: s.setOpenSheet,
      mixAllowed: canEditMix(s.projectPath, s.guestMode, s.shareCapabilities),
    })),
  );
  return (
    <div className="tools-sheet">
      <EditSurfaceSwitch surface={surface} onSurfaceChange={setSurface} />
      {surface === "lanes" ? <EditToolStrip /> : null}
      {mixAllowed ? (
        <Button title="Mix" onClick={() => setOpenSheet("mix")}>
          <SystemIcon name="sliders-horizontal" size={20} />
          Mix
        </Button>
      ) : null}
    </div>
  );
}
