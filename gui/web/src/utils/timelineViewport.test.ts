import { describe, expect, it } from "vitest";
import {
  fixedPlayheadLeadPx,
  MIN_TIMELINE_WIDTH_PX,
  scrollLeftCenteringSec,
  secAtViewportCenter,
  timelineCanvasSize,
  timelineHeaderOffsetWidth,
  timelineTimeViewportWidth,
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

  it("pads each side by half the time viewport", () => {
    expect(fixedPlayheadLeadPx(viewport)).toBe(187.5);
    expect(fixedPlayheadLeadPx(-10)).toBe(0);
  });

  it("can centre every time from 0 to the end at fit zoom (#385)", () => {
    const lead = fixedPlayheadLeadPx(viewport);
    const { widthPx, durationSec } = timelineCanvasSize(60, zoom, viewport);
    // DOM scroll range with the time column padded by `lead` on each side.
    const maxDomScroll = lead + widthPx + lead - viewport;
    for (const sec of [0, 0.5, 15, 30, 59.5, durationSec]) {
      const logical = scrollLeftCenteringSec(sec, zoom, viewport);
      const dom = logical + lead;
      expect(dom, `${sec}s`).toBeGreaterThanOrEqual(0);
      expect(dom, `${sec}s`).toBeLessThanOrEqual(maxDomScroll + 1e-9);
      expect(
        secAtViewportCenter(logical, zoom, viewport, durationSec),
      ).toBeCloseTo(sec, 9);
    }
  });

  it("clamps the centre time to the canvas", () => {
    expect(secAtViewportCenter(-500, zoom, viewport, 60)).toBe(0);
    expect(secAtViewportCenter(10_000, zoom, viewport, 60)).toBe(60);
  });
});
