import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZOOM_STEP } from "../utils/zoom";
import {
  attachTimelineZoomGestures,
  isPointerOverTimeline,
  isZoomWheelEvent,
  shouldClaimTimelineZoom,
} from "./timelineZoomGestures";

describe("isZoomWheelEvent", () => {
  it("detects ctrl or meta (trackpad pinch / modifier+wheel)", () => {
    expect(isZoomWheelEvent({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheelEvent({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isZoomWheelEvent({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("shouldClaimTimelineZoom", () => {
  let el: HTMLDivElement;
  let outside: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement("div");
    outside = document.createElement("div");
    document.body.append(el, outside);
  });

  afterEach(() => {
    el.remove();
    outside.remove();
  });

  it("claims when the event target is inside the timeline", () => {
    expect(
      shouldClaimTimelineZoom({
        el,
        clientX: 0,
        clientY: 0,
        eventTarget: el,
        activeElement: document.body,
      }),
    ).toBe(true);
  });

  it("refuses when an editable is focused", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(
      shouldClaimTimelineZoom({
        el,
        clientX: 0,
        clientY: 0,
        eventTarget: el,
        activeElement: input,
      }),
    ).toBe(false);
    input.remove();
  });

  it("claims over the scroller but not inside an excluded region (#385)", () => {
    // Fixed-playhead lead pads are scroller margin, not the time column.
    const pad = document.createElement("div");
    const headers = document.createElement("div");
    el.append(pad, headers);
    let hit: Element = pad;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => hit,
    });
    const claim = () =>
      shouldClaimTimelineZoom({
        el,
        clientX: 10,
        clientY: 10,
        eventTarget: hit,
        activeElement: document.body,
        exclude: headers,
      });
    expect(claim()).toBe(true);
    hit = headers;
    expect(claim()).toBe(false);
    expect(isPointerOverTimeline(el, 10, 10, headers, headers)).toBe(false);
  });

  it("refuses when the pointer hit is outside the timeline", () => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => outside,
    });
    expect(isPointerOverTimeline(el, 10, 10, outside)).toBe(false);
    expect(
      shouldClaimTimelineZoom({
        el,
        clientX: 10,
        clientY: 10,
        eventTarget: outside,
        activeElement: document.body,
      }),
    ).toBe(false);
  });
});

describe("attachTimelineZoomGestures", () => {
  let el: HTMLDivElement;
  let zoom: number;
  let applied: { zoom: number; clientX: number }[];
  let claimed: number;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    zoom = 40;
    applied = [];
    claimed = 0;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => el,
    });
  });

  afterEach(() => {
    el.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers wheel and touchmove as non-passive", () => {
    const spy = vi.spyOn(el, "addEventListener");
    const dispose = attachTimelineZoomGestures(el, {
      getZoom: () => zoom,
      applyZoomAt: () => undefined,
    });

    const wheelCall = spy.mock.calls.find((c) => c[0] === "wheel");
    const touchMoveCall = spy.mock.calls.find((c) => c[0] === "touchmove");
    expect(wheelCall?.[2]).toEqual({ passive: false });
    expect(touchMoveCall?.[2]).toEqual({ passive: false });

    dispose();
  });

  it("zooms on ctrl+wheel, preventDefault, and notifies claim", () => {
    attachTimelineZoomGestures(el, {
      getZoom: () => zoom,
      applyZoomAt: (next, clientX) => {
        applied.push({ zoom: next, clientX });
      },
      onZoomClaimed: () => {
        claimed += 1;
      },
    });

    const e = new WheelEvent("wheel", {
      deltaY: -10,
      ctrlKey: true,
      clientX: 120,
      clientY: 40,
      cancelable: true,
      bubbles: true,
    });
    Object.defineProperty(e, "target", { value: el });
    el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(applied).toEqual([{ zoom: 40 * ZOOM_STEP, clientX: 120 }]);
    expect(claimed).toBe(1);
  });

  it("ignores plain wheel (no modifier) so native scroll works", () => {
    attachTimelineZoomGestures(el, {
      getZoom: () => zoom,
      applyZoomAt: (next, clientX) => {
        applied.push({ zoom: next, clientX });
      },
      onZoomClaimed: () => {
        claimed += 1;
      },
    });

    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 20,
        clientX: 50,
        clientY: 10,
        cancelable: true,
      }),
    );
    expect(applied).toEqual([]);
    expect(claimed).toBe(0);
  });

  it("does not claim zoom while typing in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    attachTimelineZoomGestures(el, {
      getZoom: () => zoom,
      applyZoomAt: (next, clientX) => {
        applied.push({ zoom: next, clientX });
      },
      onZoomClaimed: () => {
        claimed += 1;
      },
    });

    const e = new WheelEvent("wheel", {
      deltaY: -10,
      ctrlKey: true,
      clientX: 120,
      clientY: 40,
      cancelable: true,
    });
    el.dispatchEvent(e);
    expect(applied).toEqual([]);
    expect(claimed).toBe(0);
    expect(e.defaultPrevented).toBe(false);
    input.remove();
  });

  it("ignores wheel zoom while a Safari gesture session is active", () => {
    class FakeGestureEvent extends Event {
      scale: number;
      clientX: number;
      clientY: number;
      constructor(
        type: string,
        init?: EventInit & {
          scale?: number;
          clientX?: number;
          clientY?: number;
        },
      ) {
        super(type, init);
        this.scale = init?.scale ?? 1;
        this.clientX = init?.clientX ?? 0;
        this.clientY = init?.clientY ?? 0;
      }
    }
    vi.stubGlobal("GestureEvent", FakeGestureEvent);
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      configurable: true,
    });
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
    });

    attachTimelineZoomGestures(el, {
      getZoom: () => zoom,
      applyZoomAt: (next, clientX) => {
        applied.push({ zoom: next, clientX });
      },
    });

    el.dispatchEvent(
      new FakeGestureEvent("gesturestart", {
        scale: 1,
        clientX: 200,
        clientY: 20,
        cancelable: true,
      }),
    );
    el.dispatchEvent(
      new FakeGestureEvent("gesturechange", {
        scale: 1.5,
        clientX: 200,
        clientY: 20,
        cancelable: true,
      }),
    );
    expect(applied).toEqual([{ zoom: 60, clientX: 200 }]);

    applied = [];
    const wheel = new WheelEvent("wheel", {
      deltaY: -10,
      ctrlKey: true,
      clientX: 200,
      clientY: 20,
      cancelable: true,
    });
    el.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(applied).toEqual([]);

    el.dispatchEvent(new FakeGestureEvent("gestureend", { cancelable: true }));
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -10,
        ctrlKey: true,
        clientX: 200,
        clientY: 20,
        cancelable: true,
      }),
    );
    expect(applied).toEqual([{ zoom: 40 * ZOOM_STEP, clientX: 200 }]);
  });

  it("re-reads a live hit-test getter after a late timeline-time mount", () => {
    let hit: HTMLElement | null = null;
    attachTimelineZoomGestures(
      el,
      {
        getZoom: () => zoom,
        applyZoomAt: (next, clientX) => {
          applied.push({ zoom: next, clientX });
        },
      },
      () => hit,
    );

    const first = new WheelEvent("wheel", {
      deltaY: -10,
      ctrlKey: true,
      clientX: 120,
      clientY: 40,
      cancelable: true,
      bubbles: true,
    });
    Object.defineProperty(first, "target", { value: el });
    el.dispatchEvent(first);
    expect(applied).toHaveLength(1);

    const time = document.createElement("div");
    document.body.appendChild(time);
    hit = time;
    applied = [];
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => el,
    });
    const second = new WheelEvent("wheel", {
      deltaY: -10,
      ctrlKey: true,
      clientX: 120,
      clientY: 40,
      cancelable: true,
      bubbles: true,
    });
    Object.defineProperty(second, "target", { value: el });
    el.dispatchEvent(second);
    expect(applied).toEqual([]);
    time.remove();
  });
});
