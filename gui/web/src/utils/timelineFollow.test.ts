import { describe, expect, it } from "vitest";
import {
  followPageTarget,
  isPlayheadOffscreen,
  revealTargetPx,
} from "./timelineFollow";

const view = {
  zoomPxPerSec: 10,
  viewportPx: 400,
  canvasWidthPx: 2000,
  scrollPx: 0,
};

describe("followPageTarget", () => {
  it("returns null while the playhead is inside the margin", () => {
    expect(followPageTarget({ ...view, playheadSec: 0 })).toBeNull();
    expect(followPageTarget({ ...view, playheadSec: 33 })).toBeNull();
    expect(followPageTarget({ ...view, playheadSec: 36.8 })).toBeNull();
  });

  it("lands at about 15% of the viewport and clamps to the canvas end", () => {
    expect(followPageTarget({ ...view, playheadSec: 37 })).toBe(310);
    expect(
      followPageTarget({ ...view, playheadSec: 190, canvasWidthPx: 2000 }),
    ).toBe(1600);
    expect(
      followPageTarget({ ...view, playheadSec: 190, canvasWidthPx: 1900 }),
    ).toBe(1500);
  });

  it("pages back when the playhead is left of the view", () => {
    expect(followPageTarget({ ...view, scrollPx: 500, playheadSec: 40 })).toBe(
      340,
    );
    expect(followPageTarget({ ...view, scrollPx: 500, playheadSec: 2 })).toBe(
      0,
    );
  });

  it("returns null when the clamped target is the scroll it already has", () => {
    expect(
      followPageTarget({
        ...view,
        canvasWidthPx: 600,
        scrollPx: 200,
        playheadSec: 58,
      }),
    ).toBeNull();
  });

  it("scales the margin with the viewport between 32 and 96 px", () => {
    const wide = { ...view, viewportPx: 1600, canvasWidthPx: 20000 };
    expect(followPageTarget({ ...wide, playheadSec: 150 })).toBeNull();
    expect(followPageTarget({ ...wide, playheadSec: 150.5 })).toBe(1265);
    const narrow = { ...view, viewportPx: 100, canvasWidthPx: 20000 };
    expect(followPageTarget({ ...narrow, playheadSec: 6.7 })).toBeNull();
    expect(followPageTarget({ ...narrow, playheadSec: 6.9 })).toBe(54);
  });
});

describe("isPlayheadOffscreen", () => {
  it("is true only past either edge of the viewport", () => {
    expect(isPlayheadOffscreen({ ...view, playheadSec: 0 })).toBe(false);
    expect(isPlayheadOffscreen({ ...view, playheadSec: 40 })).toBe(false);
    expect(isPlayheadOffscreen({ ...view, playheadSec: 41 })).toBe(true);
    expect(
      isPlayheadOffscreen({ ...view, scrollPx: 100, playheadSec: 9 }),
    ).toBe(true);
  });
});

describe("revealTargetPx", () => {
  const geometry = {
    zoomPxPerSec: 10,
    viewportPx: 400,
    canvasWidthPx: 600,
  };

  it("centers the playhead and clamps to both ends of the canvas", () => {
    expect(revealTargetPx({ ...geometry, playheadSec: 30 })).toBe(100);
    expect(revealTargetPx({ ...geometry, playheadSec: 58 })).toBe(200);
    expect(revealTargetPx({ ...geometry, playheadSec: 5 })).toBe(0);
  });

  it("never goes negative when the canvas is narrower than the view", () => {
    expect(
      revealTargetPx({ ...geometry, canvasWidthPx: 300, playheadSec: 20 }),
    ).toBe(0);
  });
});
