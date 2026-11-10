import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, placeTrimHint, visibleLanes } from "./trimHintPlace";

const box = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): Box => ({
  left,
  top,
  right,
  bottom,
});
const view = box(64, 150, 380, 600);
const tip = { width: 194, height: 52 };
const gap = 4;
const base = { view, tip, handle: 8, gap };

describe("placeTrimHint", () => {
  it("hangs above the clip at its start", () => {
    expect(placeTrimHint({ ...base, clip: box(100, 300, 400, 352) })).toEqual({
      left: 100,
      top: 244,
    });
  });

  it("goes below when the ruler row is above the clip", () => {
    expect(placeTrimHint({ ...base, clip: box(100, 160, 400, 212) })).toEqual({
      left: 100,
      top: 216,
    });
  });

  it("pulls back to the visible edge when the clip starts under the headers", () => {
    expect(
      placeTrimHint({ ...base, clip: box(-300, 300, 400, 352) })?.left,
    ).toBe(64);
  });

  it("pulls back from the right edge when the clip starts near it", () => {
    expect(
      placeTrimHint({ ...base, clip: box(360, 300, 900, 352) })?.left,
    ).toBe(380 - 194);
  });

  it("goes over the clip past its handle when neither side has room", () => {
    const tight = box(64, 150, 380, 240);
    expect(
      placeTrimHint({ ...base, view: tight, clip: box(100, 160, 400, 232) }),
    ).toEqual({ left: 112, top: 164 });
  });

  it("never lies over the start handle, even where the view edge would pull it back onto it", () => {
    const tight = box(64, 150, 380, 240);
    expect(
      placeTrimHint({ ...base, view: tight, clip: box(350, 160, 900, 232) }),
    ).toBeNull();
  });

  it("returns null when no spot shows the whole tip", () => {
    expect(
      placeTrimHint({
        ...base,
        view: box(64, 150, 380, 210),
        clip: box(100, 160, 400, 200),
      }),
    ).toBeNull();
  });

  it("returns null when the tip is wider than the view", () => {
    expect(
      placeTrimHint({
        ...base,
        view: box(64, 150, 200, 600),
        clip: box(100, 300, 400, 352),
      }),
    ).toBeNull();
  });

  it("returns null when the clip lies wholly under the headers", () => {
    const narrow = box(64, 150, 380, 240);
    expect(
      placeTrimHint({ ...base, view: narrow, clip: box(-400, 160, 60, 232) }),
    ).toBeNull();
  });

  it("refuses an inner spot the view edge pulls back into the handle's strip", () => {
    expect(
      placeTrimHint({
        ...base,
        clip: box(180, 160, 900, 232),
        view: box(64, 150, 380, 240),
      }),
    ).toBeNull();
  });

  it("fits exactly against each edge of the view", () => {
    const v = box(64, 150, 380, 600);
    expect(
      placeTrimHint({ ...base, clip: box(100, 206, 400, 258), view: v }),
    ).toEqual({ left: 100, top: 150 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 150, 400, 194), view: v }),
    ).toEqual({ left: 100, top: 198 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 400, 400, 544), view: v }),
    ).toEqual({ left: 100, top: 344 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 604, 400, 640), view: v }),
    ).toEqual({ left: 100, top: 548 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 100, 400, 146), view: v }),
    ).toEqual({ left: 100, top: 150 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 160, 400, 544), view: v }),
    ).toEqual({ left: 100, top: 548 });
    expect(
      placeTrimHint({ ...base, clip: box(100, 700, 400, 800), view: v }),
    ).toBeNull();
  });

  it("fits the over-the-clip spot exactly against the view's top and bottom", () => {
    const clip = box(100, 160, 400, 232);
    expect(
      placeTrimHint({ ...base, view: box(64, 150, 380, 215), clip }),
    ).toBeNull();
    expect(
      placeTrimHint({ ...base, view: box(64, 150, 380, 216), clip }),
    ).toEqual({ left: 112, top: 164 });
    expect(
      placeTrimHint({
        ...base,
        view: box(64, 164, 380, 230),
        clip: box(100, 160, 400, 232),
      }),
    ).toEqual({ left: 112, top: 164 });
  });
});

const rectOf = (left: number, top: number, right: number, bottom: number) =>
  ({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }) as DOMRect;

function lanes() {
  document.body.innerHTML = `
    <div class="timeline-scroll">
      <div class="track-headers"></div>
      <div class="timeline-ruler"></div>
      <div class="marker-lane"></div>
      <div id="clip"></div>
    </div>`;
  const boxes: Record<string, DOMRect> = {
    "timeline-scroll": rectOf(0, 96, 390, 600),
    "track-headers": rectOf(0, 96, 56, 600),
    "timeline-ruler": rectOf(56, 96, 390, 120),
    "marker-lane": rectOf(56, 120, 390, 144),
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const key = [...this.classList].find((c) => boxes[c]);
      return key ? boxes[key] : rectOf(0, 0, 0, 0);
    },
  );
  const scroller = document.querySelector(".timeline-scroll") as HTMLElement;
  Object.defineProperty(scroller, "clientWidth", { value: 375 });
  Object.defineProperty(scroller, "clientHeight", { value: 489 });
  return document.getElementById("clip") as HTMLElement;
}

describe("visibleLanes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("starts right of the track headers and under the sticky ruler and marker rows", () => {
    const view = visibleLanes(lanes(), 8);
    expect(view.left).toBe(64);
    expect(view.top).toBe(152);
  });

  it("stops at the scroller's own right and bottom edges, margin in", () => {
    const view = visibleLanes(lanes(), 8);
    expect(view.right).toBe(367);
    expect(view.bottom).toBe(577);
  });

  it("is the screen, margin in, for a clip outside any timeline scroller", () => {
    document.body.innerHTML = '<div id="clip"></div>';
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 700);
    const view = visibleLanes(document.getElementById("clip")!, 8);
    expect(view).toEqual({ left: 8, top: 8, right: 352, bottom: 692 });
    vi.unstubAllGlobals();
  });

  it("starts under the ruler when no marker row is drawn", () => {
    document.body.innerHTML = `<div class="timeline-scroll"><div class="timeline-ruler"></div><div id="clip"></div></div>`;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.classList.contains("timeline-scroll"))
          return rectOf(0, 96, 390, 600);
        if (this.classList.contains("timeline-ruler"))
          return rectOf(0, 96, 390, 120);
        return rectOf(0, 0, 0, 0);
      },
    );
    const scroller = document.querySelector(".timeline-scroll") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", { value: 390 });
    Object.defineProperty(scroller, "clientHeight", { value: 504 });
    expect(visibleLanes(document.getElementById("clip")!, 8).top).toBe(128);
  });

  it("starts at the scroller's own top left without headers or sticky rows", () => {
    document.body.innerHTML = `<div class="timeline-scroll"><div id="clip"></div></div>`;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return this.classList.contains("timeline-scroll")
          ? rectOf(20, 30, 390, 600)
          : rectOf(0, 0, 0, 0);
      },
    );
    const scroller = document.querySelector(".timeline-scroll") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", { value: 370 });
    Object.defineProperty(scroller, "clientHeight", { value: 570 });
    const view = visibleLanes(document.getElementById("clip")!, 8);
    expect([view.left, view.top]).toEqual([28, 38]);
  });
});
