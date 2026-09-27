import { addChapter } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { OverlayLegendView } from "./OverlayLegendView";

export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible, projectPath, setSelection } = useDaw(
    (s) => ({
      layers: s.layers,
      setLayerVisible: s.setLayerVisible,
      projectPath: s.projectPath,
      setSelection: s.setSelection,
    }),
  );
  const hostEditable = !isShareProjectKey(projectPath);

  const addChapterAtPlayhead = async () => {
    const playheadSec = useDawStore.getState().playheadSec;
    const title = `Chapter ${playheadSec.toFixed(1)}s`;
    await addChapter(projectPath, playheadSec, title);
    setSelection({
      kind: "chapter",
      id: title,
      time: playheadSec,
    });
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
