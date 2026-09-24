import { describe, expect, it } from "vitest";
import { clientXToTimelineSec } from "./timelinePointer";
import {
  centerSecToScrollLeft,
  domToLogicalScrollLeft,
  fixedPlayheadCanvasSize,
  fixedPlayheadLeadPx,
  fixedPlayheadLinePx,
  logicalToDomScrollLeft,
  MIN_TIMELINE_WIDTH_PX,
  measureTimelineColumns,
  minLogicalScrollLeft,
  scrollLeftToCenterSec,
  timelineCanvasSize,
  timelineHeaderOffsetWidth,
  timelineTimeViewportWidth,
  viewportCenterOffsetPx,
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

  it("pads each side by the viewport's center offset", () => {
    expect(viewportCenterOffsetPx(viewport)).toBe(187.5);
    expect(viewportCenterOffsetPx(-10)).toBe(0);
    expect(fixedPlayheadLeadPx(viewport)).toBe(
      viewportCenterOffsetPx(viewport),
    );
    expect(fixedPlayheadLinePx(64, 311)).toBe(64 + 155.5);
  });

  it("can center every time from 0 to the end at fit zoom (#385)", () => {
    const lead = fixedPlayheadLeadPx(viewport);
    const { widthPx, durationSec } = timelineCanvasSize(60, zoom, viewport);
    // DOM scroll range with the time column padded by `lead` on each side.
    const maxDomScroll = lead + widthPx + lead - viewport;
    for (const sec of [0, 0.5, 15, 30, 59.5, durationSec]) {
      const logical = centerSecToScrollLeft(sec, zoom, viewport);
      const dom = logicalToDomScrollLeft(logical, lead);
      expect(dom, `${sec}s`).toBeGreaterThanOrEqual(0);
      expect(dom, `${sec}s`).toBeLessThanOrEqual(maxDomScroll + 1e-9);
      expect(domToLogicalScrollLeft(dom, lead)).toBe(logical);
      expect(
        scrollLeftToCenterSec(logical, zoom, viewport, durationSec),
      ).toBeCloseTo(sec, 9);
    }
  });

  it("clamps the center time to the given end", () => {
    expect(scrollLeftToCenterSec(-500, zoom, viewport, 60)).toBe(0);
    expect(scrollLeftToCenterSec(10_000, zoom, viewport, 60)).toBe(60);
    // Below fit the canvas outlasts the session; callers pass the session end.
    expect(scrollLeftToCenterSec(10_000, zoom / 2, viewport, 60)).toBe(60);
  });

  it("sizes a fixed-playhead canvas to the session, even below fit", () => {
    // Below fit (5 px/s < 400/60) the range must still end at 60 s.
    const lead = fixedPlayheadLeadPx(viewport);
    const { widthPx, durationSec } = fixedPlayheadCanvasSize(60, 5);
    expect(widthPx).toBe(300);
    expect(durationSec).toBe(60);
    const maxDom = lead + widthPx + lead - viewport;
    const maxLogical = domToLogicalScrollLeft(maxDom, lead);
    expect(scrollLeftToCenterSec(maxLogical, 5, viewport, 60)).toBe(60);
    expect(
      scrollLeftToCenterSec(minLogicalScrollLeft(lead), 5, viewport, 60),
    ).toBe(0);
  });

  it("floors logical scroll at −lead, or +0 when unpadded", () => {
    expect(minLogicalScrollLeft(200)).toBe(-200);
    expect(Object.is(minLogicalScrollLeft(0), 0)).toBe(true);
  });

  it("agrees with the pointer mapping at the viewport's center", () => {
    const scrollLeft = 123;
    expect(scrollLeftToCenterSec(scrollLeft, zoom, viewport, 60)).toBe(
      clientXToTimelineSec(viewport / 2, { left: 0 }, scrollLeft, zoom, 60),
    );
  });
});
