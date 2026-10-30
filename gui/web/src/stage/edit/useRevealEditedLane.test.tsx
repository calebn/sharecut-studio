import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubResizeObserver } from "../../test/resizeObserver";
import { useRevealEditedLane } from "./useRevealEditedLane";

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top, left: 0, right: 100 } as DOMRect;
}

/** A scroller 100 to 300 px tall under a 20 px ruler, holding one lane. */
function mount(laneTop: number, laneBottom: number): HTMLElement {
  document.body.innerHTML = `
    <div class="timeline-scroll">
      <div class="timeline-ruler"></div>
      <div class="lane-row" data-track-id="host"></div>
    </div>`;
  const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
  scroller.getBoundingClientRect = () => rect(100, 300);
  document.querySelector(".timeline-ruler")!.getBoundingClientRect = () =>
    rect(100, 120);
  const lane = document.querySelector(".lane-row")!;
  lane.getBoundingClientRect = () =>
    rect(laneTop - scroller.scrollTop, laneBottom - scroller.scrollTop);
  return scroller;
}

/** Mounts the hook for `trackId`, which reveals the lane once. */
function revealLane(trackId: string) {
  renderHook(() => useRevealEditedLane(trackId));
}

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("revealing a lane", () => {
  it("scrolls a lane cut off at the bottom up until it is whole", () => {
    const scroller = mount(230, 301);
    revealLane("host");
    expect(scroller.scrollTop).toBe(1);
  });

  it("scrolls a lane tucked under the ruler back down", () => {
    const scroller = mount(140, 200);
    scroller.scrollTop = 30;
    revealLane("host");
    expect(scroller.scrollTop).toBe(20);
  });

  it("never scrolls the lane's top above the pinned ruler to fit a tall lane", () => {
    const scroller = mount(130, 400);
    revealLane("host");
    expect(scroller.scrollTop).toBe(10);
  });

  it("leaves a whole lane and a missing lane alone", () => {
    const scroller = mount(150, 220);
    revealLane("host");
    revealLane("gone");
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("useRevealEditedLane", () => {
  it("reveals the lane when set and does nothing for null", () => {
    const scroller = mount(230, 301);
    const hook = renderHook(
      ({ id }: { id: string | null }) => useRevealEditedLane(id),
      { initialProps: { id: null as string | null } },
    );
    expect(scroller.scrollTop).toBe(0);
    act(() => hook.rerender({ id: "host" }));
    expect(scroller.scrollTop).toBe(1);
  });
});
