import { runPointerCommand } from "../../commands/pointer";
import { useDaw } from "../../state/useDaw";
import {
  clampZoomPxPerSec,
  discreteZoomFactor,
  sessionSecOf,
} from "../../utils/zoom";

export type ZoomAvailability = { canZoomIn: boolean; canZoomOut: boolean };

function zoomAvailability(
  zoomPxPerSec: number,
  sessionSec: number,
): ZoomAvailability {
  const moves = (direction: "in" | "out") =>
    clampZoomPxPerSec(
      zoomPxPerSec * discreteZoomFactor(direction),
      sessionSec,
    ) !== zoomPxPerSec;
  return { canZoomIn: moves("in"), canZoomOut: moves("out") };
}

export function useZoomControls() {
  const zoom = useDaw((state) =>
    zoomAvailability(state.zoomPxPerSec, sessionSecOf(state)),
  );
  return {
    zoom,
    onZoomIn: () => runPointerCommand("view.zoomIn"),
    onZoomOut: () => runPointerCommand("view.zoomOut"),
  };
}
