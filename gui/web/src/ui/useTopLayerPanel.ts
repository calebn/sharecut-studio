import { useCallback } from "react";
import { popoverSupported, showInTopLayer } from "./topLayerFloor";

/**
 * Props for a floating panel that must sit in the top layer: spread
 * `popover` on the element and pass `ref` as its ref. Without the Popover API
 * both are inert and the panel keeps its fixed `--z-menu` stacking.
 */
export function useTopLayerPanel() {
  const native = popoverSupported();
  const ref = useCallback(
    (panel: HTMLElement | null) => {
      if (!panel || !native) return;
      return showInTopLayer(panel);
    },
    [native],
  );
  return { ref, popover: native ? ("manual" as const) : undefined };
}
