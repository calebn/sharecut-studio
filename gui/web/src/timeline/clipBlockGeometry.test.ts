import { describe, expect, it } from "vitest";
import { clipRow } from "../test/fixtures";
import { clipBlockGeometry } from "./clipBlockGeometry";

const ZOOM = 40;
const geometry = clipBlockGeometry;

describe("clipBlockGeometry", () => {
  it("equals the committed clip with no previews", () => {
    const clip = clipRow({
      source_start: 5,
      source_end: 12,
      timeline_start: 4,
    });
    const g = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: null,
      fadePreview: null,
      previewTimelineStart: null,
    });
    expect(g.left).toBe(4 * ZOOM);
    expect(g.width).toBe(Math.max(4, 7 * ZOOM));
    expect(g.ghostExtraPx).toBe(0);
    expect(g.fadeDragEdge).toBeNull();
    expect(g.trimDragging).toBe(false);
  });

  it("gives a trim-out ghost past source_end", () => {
    const clip = clipRow({ source_start: 5, source_end: 12 });
    const g = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: { edge: "out", sourceStart: 5, sourceEnd: 13.5 },
      fadePreview: null,
      previewTimelineStart: null,
    });
    expect(g.ghostExtraPx).toBeCloseTo((13.5 - 12) * ZOOM);
    expect(g.ghostSourceStart).toBe(12);
    expect(g.trimDragging).toBe(true);
  });

  it("gives an in-edge expand ghost from the preview's start", () => {
    const clip = clipRow({ source_start: 5, source_end: 12 });
    const g = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: { edge: "in", sourceStart: 3, sourceEnd: 12 },
      fadePreview: null,
      previewTimelineStart: null,
    });
    expect(g.ghostSourceStart).toBe(3);
  });

  it("shifts sourceStart and timelineStart under a roll and ignores previewTimelineStart", () => {
    const clip = clipRow({
      id: "right",
      source_start: 10,
      source_end: 15,
      timeline_start: 5,
    });
    const g = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: {
        leftClipId: "left",
        rightClipId: "right",
        deltaSec: 1.5,
      },
      trimPreview: null,
      fadePreview: null,
      previewTimelineStart: 99,
    });
    expect(g.sourceStart).toBe(11.5);
    expect(g.left).toBe((5 + 1.5) * ZOOM);
    expect(g.rollActive).toBe(true);
  });

  it("follows a live fade drag in timeline px, down to 0", () => {
    const clip = clipRow({ fade_in_ms: 200, fade_out_ms: 500 });
    const committed = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: null,
      fadePreview: null,
      previewTimelineStart: null,
    });
    expect(committed.fadeInPx).toBeCloseTo(0.2 * ZOOM, 9);
    expect(committed.fadeOutPx).toBeCloseTo(0.5 * ZOOM, 9);

    const dragged = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: null,
      fadePreview: { edge: "in", inMs: 0, outMs: 500 },
      previewTimelineStart: null,
    });
    expect(dragged.fadeInPx).toBe(0);
    expect(dragged.fadeDragEdge).toBe("in");
  });
});
