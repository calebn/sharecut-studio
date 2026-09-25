import { describe, expect, it } from "vitest";
import {
  effectiveMaxZoomPxPerSec,
  MAX_CONTENT_PX,
  MAX_ZOOM_PX_PER_SEC,
  PAINT_DPR_CAP,
  paintDpr,
  RENDER_TILE_CSS_PX,
} from "./timelineZoom.generated";

describe("paintDpr", () => {
  it("rounds to a 1/8 grid so a render tile is whole device pixels", () => {
    expect(paintDpr(1.33)).toBe(1.375);
    expect(paintDpr(1.5)).toBe(1.5);
    expect(paintDpr(1.0625)).toBe(1.125); // half rounds up (Math.round)
    for (const dpr of [1, 1.1, 1.25, 1.33, 1.5, 1.75, 1.99]) {
      expect(Number.isInteger(RENDER_TILE_CSS_PX * paintDpr(dpr))).toBe(true);
    }
  });

  it("clamps to [1, PAINT_DPR_CAP] and ignores bad input", () => {
    expect(paintDpr(0.5)).toBe(1);
    expect(paintDpr(3)).toBe(PAINT_DPR_CAP);
    expect(paintDpr(Number.NaN)).toBe(1);
    expect(paintDpr(-2)).toBe(1);
  });
});

describe("effectiveMaxZoomPxPerSec", () => {
  it("keeps timeline content under MAX_CONTENT_PX", () => {
    expect(effectiveMaxZoomPxPerSec(3600)).toBeCloseTo(
      Math.min(MAX_ZOOM_PX_PER_SEC, MAX_CONTENT_PX / 3600),
    );
    expect(effectiveMaxZoomPxPerSec(3600) * 3600).toBeLessThanOrEqual(
      MAX_CONTENT_PX,
    );
  });

  it("treats sessions under one second as one second", () => {
    expect(effectiveMaxZoomPxPerSec(0)).toBe(
      Math.min(MAX_ZOOM_PX_PER_SEC, MAX_CONTENT_PX),
    );
  });
});
