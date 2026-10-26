import { describe, expect, it } from "vitest";
import {
  clampZoomPxPerSec,
  MIN_ZOOM_PX_PER_SEC,
  ZOOM_STEP,
} from "../../utils/zoom";
import { zoomAvailability } from "./useZoomControls";

describe("zoomAvailability", () => {
  const sessionSec = 60;
  const ceiling = clampZoomPxPerSec(Number.MAX_SAFE_INTEGER, sessionSec);

  it("allows both steps between the limits", () => {
    expect(zoomAvailability(20, sessionSec)).toEqual({
      canZoomIn: true,
      canZoomOut: true,
    });
  });

  it("stops Zoom out at the floor", () => {
    expect(zoomAvailability(MIN_ZOOM_PX_PER_SEC, sessionSec)).toEqual({
      canZoomIn: true,
      canZoomOut: false,
    });
  });

  it("stops Zoom in at the session's ceiling", () => {
    expect(zoomAvailability(ceiling, sessionSec)).toEqual({
      canZoomIn: false,
      canZoomOut: true,
    });
  });

  it("still allows the step that lands short of the ceiling", () => {
    expect(
      zoomAvailability(ceiling / ZOOM_STEP / 2, sessionSec).canZoomIn,
    ).toBe(true);
  });
});
