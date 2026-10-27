import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { OverlayLegendView } from "./OverlayLegendView";

/** Timeline layer visibility checkboxes. Adding a chapter is `edit.addChapter` (plus menu). */
export function OverlayLegend() {
  const { layers, setLayerVisible, projectPath } = useDaw((s) => ({
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
    projectPath: s.projectPath,
  }));
  const hostEditable = !isShareProjectKey(projectPath);

  return (
    <OverlayLegendView
      layers={layers}
      onLayerChange={setLayerVisible}
      hostLayers={hostEditable}
    />
  );
}
