import { afterEach, describe, expect, it } from "vitest";
import { useDawStore } from "./dawStore";
import { timelineViewportRegistry } from "./timelineViewportRegistry";

afterEach(() => timelineViewportRegistry.clear());

describe("timeline viewport registry", () => {
  it("keeps mounted DOM nodes outside the reactive DAW state", () => {
    const timeline = document.createElement("div");
    const lanes = document.createElement("div");
    Object.defineProperty(timeline, "clientWidth", { value: 640 });
    timelineViewportRegistry.setTimelineElement(timeline);
    timelineViewportRegistry.setLanesElement(lanes);
    timelineViewportRegistry.setLeadPx(120);

    expect(timelineViewportRegistry.getLanesElement()).toBe(lanes);
    expect(timelineViewportRegistry.getLeadPx()).toBe(120);
    expect(useDawStore.getState().measureTimelineViewport()).toBe(640);
    expect(Object.values(useDawStore.getState())).not.toContain(timeline);
    expect(Object.values(useDawStore.getState())).not.toContain(lanes);
    expect(Object.keys(useDawStore.getState())).not.toContain("_timelineEl");

    timelineViewportRegistry.clear();
    expect(timelineViewportRegistry.getTimelineElement()).toBeNull();
    expect(timelineViewportRegistry.getLanesElement()).toBeNull();
    expect(timelineViewportRegistry.getLeadPx()).toBe(0);
    expect(useDawStore.getState().measureTimelineViewport()).toBeGreaterThan(0);
  });
});
