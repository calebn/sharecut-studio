import { addChapter } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import { OverlayLegendView } from "./OverlayLegendView";

export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const {
    layers,
    setLayerVisible,
    projectPath,
    setSelection,
    announceStatus,
    chapterAddPending,
    setChapterAddPending,
  } = useDaw((s) => ({
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
    projectPath: s.projectPath,
    setSelection: s.setSelection,
    announceStatus: s.announceStatus,
    chapterAddPending: s.chapterAddPending,
    setChapterAddPending: s.setChapterAddPending,
  }));
  const hostEditable = !isShareProjectKey(projectPath);

  const addChapterAtPlayhead = async () => {
    // A repeat click while the add is in flight would add a second chapter
    // with the same playhead-derived title. The flag lives in the DAW store,
    // not a ref, so the View menu unmounting and remounting this legend keeps
    // it, and the view can disable + Chapter while it is set.
    if (useDawStore.getState().chapterAddPending) {
      return;
    }
    setChapterAddPending(true);
    const playheadSec = useDawStore.getState().playheadSec;
    const title = `Chapter ${playheadSec.toFixed(1)}s`;
    try {
      await addChapter(projectPath, playheadSec, title);
      setSelection({
        kind: "chapter",
        id: title,
        time: playheadSec,
      });
      announceStatus(`Chapter added at ${playheadSec.toFixed(1)}s`);
    } catch (err) {
      announceStatus(`Add chapter failed: ${errorMessage(err)}`);
    } finally {
      setChapterAddPending(false);
    }
  };

  return (
    <OverlayLegendView
      menu={menu}
      layers={layers}
      onLayerChange={setLayerVisible}
      addChapterBusy={chapterAddPending}
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
