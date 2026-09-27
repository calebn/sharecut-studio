import { useRef } from "react";
import { addChapter } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import { OverlayLegendView } from "./OverlayLegendView";

export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible, projectPath, setSelection, announceStatus } =
    useDaw((s) => ({
      layers: s.layers,
      setLayerVisible: s.setLayerVisible,
      projectPath: s.projectPath,
      setSelection: s.setSelection,
      announceStatus: s.announceStatus,
    }));
  const hostEditable = !isShareProjectKey(projectPath);
  // A repeat click while the add is in flight would add a second chapter with
  // the same playhead-derived title.
  const addingChapter = useRef(false);

  const addChapterAtPlayhead = async () => {
    if (addingChapter.current) {
      return;
    }
    addingChapter.current = true;
    const playheadSec = useDawStore.getState().playheadSec;
    const title = `Chapter ${playheadSec.toFixed(1)}s`;
    try {
      await addChapter(projectPath, playheadSec, title);
      setSelection({
        kind: "chapter",
        id: title,
        time: playheadSec,
      });
    } catch (err) {
      announceStatus(`Add chapter failed: ${errorMessage(err)}`);
    } finally {
      addingChapter.current = false;
    }
  };

  return (
    <OverlayLegendView
      menu={menu}
      layers={layers}
      onLayerChange={setLayerVisible}
      onAddChapter={
        hostEditable
          ? () => {
              void addChapterAtPlayhead();
            }
          : undefined
      }
    />
  );
}
