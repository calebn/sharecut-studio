import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "./dawStore";
import { timelineViewportRegistry } from "./timelineViewportRegistry";

function timelineEl(clientWidth: number): HTMLElement {
  return {
    clientWidth,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0 }),
    querySelector: () => null,
  } as unknown as HTMLElement;
}

describe("zoomToSpan", () => {
  beforeEach(() => {
    timelineViewportRegistry.setLeadPx(0);
    useDawStore.setState({
      project: { timeline_duration_sec: 600 } as never,
      zoomPxPerSec: 1,
      scrollLeft: 0,
      userZoomed: false,
    });
  });

  afterEach(() => {
    timelineViewportRegistry.setTimelineElement(null);
  });

  it("centers the span's midpoint in a 400 px viewport at the new zoom", () => {
    timelineViewportRegistry.setTimelineElement(timelineEl(400));
    useDawStore.getState().zoomToSpan(100, 102, 300);
    const s = useDawStore.getState();
    expect(s.zoomPxPerSec).toBe(300);
    expect(s.scrollLeft).toBe(101 * 300 - 200);
    expect(s.userZoomed).toBe(true);
  });

  it("never scrolls before the start of the session", () => {
    timelineViewportRegistry.setTimelineElement(timelineEl(400));
    useDawStore.getState().zoomToSpan(0.1, 0.2, 100);
    expect(useDawStore.getState().scrollLeft).toBe(0);
  });

  it("clamps the zoom to the session's range", () => {
    timelineViewportRegistry.setTimelineElement(timelineEl(400));
    useDawStore.getState().zoomToSpan(100, 102, 1e9);
    expect(useDawStore.getState().zoomPxPerSec).toBeLessThan(1e9);
  });

  it("sets only the zoom when no timeline is mounted", () => {
    useDawStore.getState().zoomToSpan(100, 102, 300);
    const s = useDawStore.getState();
    expect(s.zoomPxPerSec).toBe(300);
    expect(s.scrollLeft).toBe(0);
  });
});
