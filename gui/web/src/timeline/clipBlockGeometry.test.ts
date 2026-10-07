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

  it("moves a grabbed start with the finger, outlining where the ripple lands it (#1135)", () => {
    const clip = clipRow({
      source_start: 5,
      source_end: 12,
      timeline_start: 4,
      timeline_end: 11,
    });
    const at = (sourceStart: number) =>
      geometry({
        clip,
        zoomPxPerSec: ZOOM,
        rollPreview: null,
        trimPreview: { edge: "in", sourceStart, sourceEnd: 12 },
        fadePreview: null,
        previewTimelineStart: null,
      });
    // Shortened by 2 s: the start sits 2 s later, the end stays, the clip
    // lands back at 4 s, and later clips move 2 s earlier.
    const shorter = at(7);
    expect({
      left: shorter.left,
      width: shorter.width,
      landing: shorter.landing,
      rippleSec: shorter.rippleSec,
      ghostExtraPx: shorter.ghostExtraPx,
    }).toEqual({
      left: 6 * ZOOM,
      width: 5 * ZOOM,
      landing: { left: -2 * ZOOM, width: 5 * ZOOM },
      rippleSec: -2,
      ghostExtraPx: 0,
    });
    // Lengthened by 2 s: real audio shows before the start, no ghost.
    const longer = at(3);
    expect({
      left: longer.left,
      landing: longer.landing,
      rippleSec: longer.rippleSec,
      ghostExtraPx: longer.ghostExtraPx,
    }).toEqual({
      left: 2 * ZOOM,
      landing: { left: 2 * ZOOM, width: 9 * ZOOM },
      rippleSec: 2,
      ghostExtraPx: 0,
    });
  });

  it("ripples later clips by a trimmed end's change, with no landing", () => {
    const clip = clipRow({
      source_start: 5,
      source_end: 12,
      timeline_start: 4,
    });
    const g = geometry({
      clip,
      zoomPxPerSec: ZOOM,
      rollPreview: null,
      trimPreview: { edge: "out", sourceStart: 5, sourceEnd: 10.5 },
      fadePreview: null,
      previewTimelineStart: null,
    });
    expect({
      landing: g.landing,
      rippleSec: g.rippleSec,
      left: g.left,
    }).toEqual({ landing: null, rippleSec: -1.5, left: 4 * ZOOM });
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
