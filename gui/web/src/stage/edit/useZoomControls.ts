import { executePointerCommand } from "../../commands/pointer";
import { useDaw } from "../../state/useDaw";
import {
  clampZoomPxPerSec,
  discreteZoomFactor,
  sessionSecOf,
} from "../../utils/zoom";

export type ZoomAvailability = { canZoomIn: boolean; canZoomOut: boolean };

export function zoomAvailability(
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
  const canZoomIn = useDaw(
    (state) =>
      zoomAvailability(state.zoomPxPerSec, sessionSecOf(state)).canZoomIn,
  );
  const canZoomOut = useDaw(
    (state) =>
      zoomAvailability(state.zoomPxPerSec, sessionSecOf(state)).canZoomOut,
  );
  return {
    zoom: { canZoomIn, canZoomOut },
    onZoomIn: () => void executePointerCommand("view.zoomIn"),
    onZoomOut: () => void executePointerCommand("view.zoomOut"),
  };
}
