import { describe, expect, it } from "vitest";
import {
  MIN_TIMELINE_WIDTH_PX,
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
