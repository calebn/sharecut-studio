import { useDaw } from "../state/useDaw";
import { OverlayLegendView } from "./OverlayLegendView";

/** Timeline layer visibility checkboxes. Adding a chapter is `edit.addChapter` (Menu › Markers, MobileShell More). */
export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible } = useDaw((s) => ({
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
  }));

  return (
    <OverlayLegendView
      menu={menu}
      layers={layers}
      onLayerChange={setLayerVisible}
    />
  );
}
