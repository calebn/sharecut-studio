import { describe, expect, it } from "vitest";
import { clientXToTimelineSec } from "./timelinePointer";
import {
  domToLogicalScrollLeft,
  fixedLineOffsetPx,
  fixedPlayheadCanvasSize,
  fixedPlayheadEndLeadPx,
  fixedPlayheadLeadPx,
  fixedPlayheadLinePx,
  followScrollLeft,
  logicalToDomScrollLeft,
  MIN_TIMELINE_WIDTH_PX,
  maxLogicalScrollLeft,
  measureTimelineColumns,
  minLogicalScrollLeft,
  scrollLeftToLineSec,
  timelineCanvasSize,
  timelineHeaderOffsetWidth,
  timelineTimeViewportWidth,
  VIEWPORT_CHUNK_PX,
  viewportCenterOffsetPx,
  viewportChunkRange,
} from "./timelineViewport";

describe("timelineViewport", () => {
  it("returns 0 header offset when no track-headers child", () => {
    const el = {
      clientWidth: 500,
      querySelector: () => null,
    };
    expect(timelineHeaderOffsetWidth(el)).toBe(0);
    expect(timelineTimeViewportWidth(el)).toBe(500);
  });

  it("subtracts sticky header width from the scrollport", () => {
    const header = { offsetWidth: 180 };
    const el = {
      clientWidth: 800,
      querySelector: (sel: string) =>
        sel === ".track-headers" ? header : null,
    };
    expect(timelineHeaderOffsetWidth(el)).toBe(180);
    expect(timelineTimeViewportWidth(el)).toBe(620);
  });

  it("clamps time viewport at zero when header is wider than scroll", () => {
    const header = { offsetWidth: 900 };
    const el = {
      clientWidth: 800,
      querySelector: () => header,
    };
    expect(timelineTimeViewportWidth(el)).toBe(0);
  });

  it("handles a null scroll element", () => {
    expect(timelineHeaderOffsetWidth(null)).toBe(0);
    expect(timelineTimeViewportWidth(null)).toBe(0);
  });

  it("measures the header, time column and classic scrollbars together", () => {
    const header = { offsetWidth: 180 };
    const el = {
      clientWidth: 785,
      clientHeight: 588,
      offsetWidth: 800,
      offsetHeight: 600,
      querySelector: () => header,
    };
    expect(measureTimelineColumns(el)).toEqual({
      headerOffsetPx: 180,
      timeViewportPx: 605,
      scrollbarInlinePx: 15,
      scrollbarBlockPx: 12,
    });
  });

  it("reports no scrollbars when they overlay the content", () => {
    const el = {
      clientWidth: 400,
      clientHeight: 300,
      offsetWidth: 400,
      offsetHeight: 300,
      querySelector: () => null,
    };
    expect(measureTimelineColumns(el)).toEqual({
      headerOffsetPx: 0,
      timeViewportPx: 400,
      scrollbarInlinePx: 0,
      scrollbarBlockPx: 0,
    });
  });
});

describe("timelineCanvasSize", () => {
  it("uses session width when zoomed in past the viewport", () => {
    const { widthPx, durationSec } = timelineCanvasSize(100, 20, 800);
    expect(widthPx).toBe(2000);
    expect(durationSec).toBe(100);
  });

  it("fills the viewport when session is narrower than the time column", () => {
    const { widthPx, durationSec } = timelineCanvasSize(60, 10, 1000);
    expect(widthPx).toBe(1000);
    expect(durationSec).toBe(100);
  });

  it("keeps a 200px floor when viewport and session are tiny", () => {
    const { widthPx, durationSec } = timelineCanvasSize(1, 10, 50);
    expect(widthPx).toBe(MIN_TIMELINE_WIDTH_PX);
    expect(durationSec).toBe(20);
  });
});

describe("fixed-playhead geometry", () => {
  const viewport = 375;
  const zoom = viewport / 60; // fit zoom for a 60 s session

  it("pads half a viewport before time 0 and a whole one after the end", () => {
    expect(viewportCenterOffsetPx(viewport)).toBe(187.5);
    expect(viewportCenterOffsetPx(-10)).toBe(0);
    // Whole pixels: a browser holds logical 0 exactly.
    expect(fixedPlayheadLeadPx(viewport)).toBe(187);
    expect(fixedPlayheadEndLeadPx(viewport)).toBe(375);
    expect(fixedPlayheadEndLeadPx(-10)).toBe(0);
    expect(fixedPlayheadLinePx(64, 155.5)).toBe(64 + 155.5);
  });

  it("loads with time 0 beside the headers, the playhead at its true place (#1707)", () => {
    expect(fixedLineOffsetPx(0, zoom, 0, viewport)).toBe(0);
    expect(fixedLineOffsetPx(10, zoom, 0, viewport)).toBeCloseTo(10 * zoom, 9);
  });

  it("keeps the playhead inside the view", () => {
    expect(fixedLineOffsetPx(0, zoom, 200, viewport)).toBe(0);
    expect(fixedLineOffsetPx(60, zoom, -500, viewport)).toBe(viewport);
  });

  it("follows the playhead to the center but never before time 0", () => {
    expect(followScrollLeft(0, zoom, viewport)).toBe(0);
    expect(followScrollLeft(10, zoom, viewport)).toBe(0);
    expect(followScrollLeft(30, zoom, viewport)).toBeCloseTo(
      30 * zoom - viewport / 2,
      9,
    );
  });

  it("moves the time by exactly what a scroll moves the content", () => {
    // Playhead 40 px in; scrolling 100 px advances it by 100 px of time.
    const sec = scrollLeftToLineSec(100, 40, zoom, 60);
    expect(sec).toBeCloseTo(140 / zoom, 9);
    expect(scrollLeftToLineSec(-500, 40, zoom, 60)).toBe(0);
    expect(scrollLeftToLineSec(10_000, 40, zoom, 60)).toBe(60);
  });

  it("can put every time under a playhead anywhere in the view (#385)", () => {
    const lead = fixedPlayheadLeadPx(viewport);
    const endLead = fixedPlayheadEndLeadPx(viewport);
    const { widthPx } = fixedPlayheadCanvasSize(60, zoom);
    // DOM scroll range with the time column padded by both leads.
    const maxDomScroll = lead + widthPx + endLead - viewport;
    expect(domToLogicalScrollLeft(maxDomScroll, lead)).toBeCloseTo(
      maxLogicalScrollLeft(60, zoom),
      9,
    );
    for (const lineX of [0, lead]) {
      for (const sec of [0, 0.5, 15, 30, 59.5, 60]) {
        const logical = sec * zoom - lineX;
        const dom = logicalToDomScrollLeft(logical, lead);
        expect(dom, `${sec}s at ${lineX}`).toBeGreaterThanOrEqual(-1e-9);
        expect(dom, `${sec}s at ${lineX}`).toBeLessThanOrEqual(
          maxDomScroll + 1e-9,
        );
        expect(scrollLeftToLineSec(logical, lineX, zoom, 60)).toBeCloseTo(
          sec,
          9,
        );
      }
    }
  });

  it("sizes a fixed-playhead canvas to the session, even below fit", () => {
    const { widthPx, durationSec } = fixedPlayheadCanvasSize(60, 5);
    expect(widthPx).toBe(300);
    expect(durationSec).toBe(60);
    expect(maxLogicalScrollLeft(60, 5)).toBe(300);
  });

  it("floors logical scroll at −lead, or +0 when unpadded", () => {
    expect(minLogicalScrollLeft(200)).toBe(-200);
    expect(Object.is(minLogicalScrollLeft(0), 0)).toBe(true);
  });

  it("agrees with the pointer mapping at the playhead's place", () => {
    const scrollLeft = 123;
    expect(scrollLeftToLineSec(scrollLeft, 80, zoom, 60)).toBe(
      clientXToTimelineSec(80, { left: 0 }, scrollLeft, zoom, 60),
    );
  });
});

describe("viewportChunkRange", () => {
  it("returns the 2048 px chunks that meet the viewport", () => {
    expect(VIEWPORT_CHUNK_PX).toBe(2048);
    expect(viewportChunkRange(0, 1200, 1e6)).toEqual([0, 0]);
    expect(viewportChunkRange(1000, 1200, 1e6)).toEqual([0, 1]);
    expect(viewportChunkRange(2048 * 100 + 5, 1200, 3e6)).toEqual([100, 100]);
  });

  it("covers at most the viewport plus two chunks", () => {
    for (const [scroll, vw] of [
      [0, 1200],
      [2047, 1200],
      [123_456, 2560],
      [2_000_000, 390],
    ] as const) {
      const [c0, c1] = viewportChunkRange(scroll, vw, 3e6);
      expect(c0 * VIEWPORT_CHUNK_PX).toBeLessThanOrEqual(scroll);
      expect((c1 + 1) * VIEWPORT_CHUNK_PX).toBeGreaterThanOrEqual(scroll + vw);
      expect((c1 - c0 + 1) * VIEWPORT_CHUNK_PX).toBeLessThanOrEqual(
        vw + 2 * VIEWPORT_CHUNK_PX,
      );
    }
  });

  it("clamps negative scroll to 0 and past-the-end scroll to the last chunk", () => {
    expect(viewportChunkRange(-500, 400, 1e6)).toEqual([0, 0]);
    expect(viewportChunkRange(9e6, 400, 5000)).toEqual([2, 2]);
    expect(viewportChunkRange(0, 400, 0)).toEqual([0, 0]);
  });
});
