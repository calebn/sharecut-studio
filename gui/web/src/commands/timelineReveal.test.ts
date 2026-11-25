import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { revealAnchor } from "./timelineReveal";

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

type Boxes = { block: DOMRect; lane: DOMRect };

function mount(boxes: Boxes) {
  const scroller = document.createElement("div");
  scroller.className = "timeline-scroll";
  Object.defineProperties(scroller, {
    clientWidth: { value: 400 },
    scrollWidth: { value: 2000 },
    clientLeft: { value: 0 },
    scrollLeft: { value: 0, writable: true },
    scrollTop: { value: 0, writable: true },
  });
  scroller.getBoundingClientRect = () => rectOf(0, 0, 400, 300);
  const lane = document.createElement("div");
  lane.className = "lane-row";
  lane.dataset.trackId = "t1";
  lane.getBoundingClientRect = () => boxes.lane;
  const block = document.createElement("div");
  block.getBoundingClientRect = () => boxes.block;
  lane.append(block);
  scroller.append(lane);
  document.body.append(scroller);
  return { scroller, block };
}

let setScrollLeft: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setScrollLeft = vi.fn();
  useDawStore.setState({ setScrollLeft } as never);
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("revealAnchor", () => {
  it("scrolls across only when the anchor is out sideways", () => {
    const { scroller, block } = mount({
      block: rectOf(900, 100, 960, 140),
      lane: rectOf(0, 80, 2000, 160),
    });
    revealAnchor(block);
    expect(setScrollLeft).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(0);
  });

  it("scrolls back when the anchor is left of the view and forward when it is right", () => {
    const left = mount({
      block: rectOf(-300, 100, -240, 140),
      lane: rectOf(-300, 80, 2000, 160),
    });
    left.scroller.scrollLeft = 500;
    revealAnchor(left.block);
    expect(setScrollLeft.mock.calls[0]?.[0]).toBe(200);
    setScrollLeft.mockClear();
    document.body.replaceChildren();
    const right = mount({
      block: rectOf(900, 100, 960, 140),
      lane: rectOf(0, 80, 2000, 160),
    });
    revealAnchor(right.block);
    expect(setScrollLeft.mock.calls[0]?.[0]).toBe(560);
  });

  it("scrolls down only when the anchor's lane is out vertically", () => {
    const { scroller, block } = mount({
      block: rectOf(100, 500, 160, 540),
      lane: rectOf(0, 480, 2000, 560),
    });
    revealAnchor(block);
    expect(setScrollLeft).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("scrolls both axes when the anchor is out on both", () => {
    const { scroller, block } = mount({
      block: rectOf(900, 500, 960, 540),
      lane: rectOf(0, 480, 2000, 560),
    });
    revealAnchor(block);
    expect(setScrollLeft).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("does nothing when the anchor is already in view", () => {
    const { scroller, block } = mount({
      block: rectOf(100, 100, 160, 140),
      lane: rectOf(0, 80, 2000, 160),
    });
    revealAnchor(block);
    expect(setScrollLeft).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(0);
  });

  it("does nothing for no node or one outside a timeline", () => {
    revealAnchor(null);
    revealAnchor(document.createElement("div"));
    expect(setScrollLeft).not.toHaveBeenCalled();
  });
});

describe("revealAnchor in a plain scroller", () => {
  it("nudges the Script pane's scroller, not the timeline, to show a word", () => {
    const pane = document.createElement("div");
    pane.style.overflowY = "auto";
    pane.getBoundingClientRect = () => rectOf(0, 0, 400, 300);
    Object.defineProperty(pane, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(pane, "scrollLeft", { value: 0, writable: true });
    const word = document.createElement("span");
    word.getBoundingClientRect = () => rectOf(50, 500, 90, 520);
    pane.append(word);
    document.body.append(pane);
    revealAnchor(word);
    expect(pane.scrollTop).toBe(220);
    expect(setScrollLeft).not.toHaveBeenCalled();
  });
});
