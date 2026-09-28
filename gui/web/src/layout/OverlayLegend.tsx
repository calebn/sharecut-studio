import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { OverlayLegendView } from "./OverlayLegendView";

/** Timeline layer visibility checkboxes. Adding a chapter is `edit.addChapter` (Menu › Markers, MobileShell More). */
export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible, projectPath } = useDaw((s) => ({
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
    projectPath: s.projectPath,
  }));
  const hostEditable = !isShareProjectKey(projectPath);

  return (
    <OverlayLegendView
      menu={menu}
      layers={layers}
      onLayerChange={setLayerVisible}
      hostLayers={hostEditable}
    />
  );
}
