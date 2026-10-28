import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "../../test/matchMedia";
import {
  FakeResizeObserver,
  stubResizeObserver,
} from "../../test/resizeObserver";
import { laneSheetCap, useKeepEditedLaneClear } from "./useKeepEditedLaneClear";

function mountSheetAndLane(): HTMLElement {
  document.body.innerHTML = `
    <div class="timeline-scroll">
      <div class="lane-row" data-track-id="host"></div>
    </div>
    <div class="bottom-sheet-root">
      <div class="bottom-sheet bottom-sheet--inspector"></div>
    </div>`;
  return document.querySelector<HTMLElement>(
    ".bottom-sheet--inspector",
  ) as HTMLElement;
}

let frames: (FrameRequestCallback | null)[];

beforeEach(() => {
  stubResizeObserver();
  stubMatchMedia(true);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const pending = () => frames.filter(Boolean).length;
const flushFrames = () =>
  act(() => {
    for (const cb of frames.splice(0)) cb?.(0);
  });
const lastObserver = () => {
  const observer = FakeResizeObserver.all.at(-1);
  if (!observer) throw new Error("no observer");
  return observer;
};

describe("useKeepEditedLaneClear", () => {
  it("refits after the observer callback returns, not inside it", () => {
    const sheet = mountSheetAndLane();
    renderHook(() => useKeepEditedLaneClear("host"));
    sheet.style.removeProperty("--sheet-lane-cap");

    act(() => lastObserver().fire());
    expect(sheet.style.getPropertyValue("--sheet-lane-cap")).toBe("");

    flushFrames();
    expect(sheet.style.getPropertyValue("--sheet-lane-cap")).not.toBe("");
  });

  it("drops a refit still waiting when the sheet closes", () => {
    const sheet = mountSheetAndLane();
    const { unmount } = renderHook(() => useKeepEditedLaneClear("host"));
    act(() => lastObserver().fire());
    unmount();
    expect(pending()).toBe(0);
    flushFrames();
    expect(sheet.style.getPropertyValue("--sheet-lane-cap")).toBe("");
  });

  it("refits once for a burst of resizes", () => {
    mountSheetAndLane();
    renderHook(() => useKeepEditedLaneClear("host"));
    act(() => {
      lastObserver().fire();
      lastObserver().fire();
    });
    expect(pending()).toBe(1);
  });
});

describe("laneSheetCap", () => {
  it("is the room under the lane's band", () => {
    expect(laneSheetCap(275, 150, 0, 44)).toBe(125);
    expect(laneSheetCap(275, 150, 56, 44)).toBe(125);
  });

  it("never leaves less than the pinned chrome and one touch row", () => {
    expect(laneSheetCap(275, 250, 0, 44)).toBe(44);
    expect(laneSheetCap(275, 250, 56, 44)).toBe(100);
  });
});
