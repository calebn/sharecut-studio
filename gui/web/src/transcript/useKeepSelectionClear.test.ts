import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_CLEAR_PX } from "../stage/edit/useCompactInspector";
import {
  keepSelectionClear,
  useKeepSelectionClear,
} from "./useKeepSelectionClear";

const sheet = vi.hoisted(() => ({
  top: null as number | null,
  bottom: 800,
  cap: null as number | null,
}));
vi.mock("../ui/compactSheet", () => ({
  inspectorSheetTop: () => sheet.top,
  inspectorSheetBottom: () => sheet.bottom,
  inspectorSheetPanel: () => null,
  capInspectorSheet: (height: number | null) => {
    sheet.cap = height;
  },
}));

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
  } as DOMRect;
}

function listWith(words: { index: number; top: number; bottom: number }[]) {
  const list = document.createElement("div");
  list.getBoundingClientRect = () => rect(100, 700);
  for (const w of words) {
    const chip = document.createElement("button");
    chip.dataset.transcriptWord = "";
    chip.dataset.trackId = "guest";
    chip.dataset.wordIndex = String(w.index);
    chip.getBoundingClientRect = () => rect(w.top, w.bottom);
    list.append(chip);
  }
  return list;
}

const range = (start: number, end: number) =>
  ({
    kind: "transcriptRange",
    trackId: "guest",
    startWordIndex: start,
    endWordIndex: end,
  }) as const;

describe("keepSelectionClear", () => {
  beforeEach(() => {
    sheet.top = 400;
    sheet.bottom = 800;
    sheet.cap = null;
    vi.stubGlobal("visualViewport", undefined);
  });

  it("scrolls the last selected word above the sheet and leaves room under the list", () => {
    const list = listWith([
      { index: 1, top: 420, bottom: 440 },
      { index: 3, top: 460, bottom: 480 },
    ]);
    keepSelectionClear(list, range(1, 3));
    expect(list.scrollTop).toBe(480 - (400 - KEEP_CLEAR_PX));
    expect(list.style.getPropertyValue("--sheet-clearance")).toBe("300px");
  });

  it("keeps the first word in view when the range is taller than the space left", () => {
    const list = listWith([
      { index: 1, top: 120, bottom: 140 },
      { index: 9, top: 900, bottom: 920 },
    ]);
    keepSelectionClear(list, range(1, 9));
    expect(list.scrollTop).toBe(20);
  });

  it("does not scroll a selection already above the sheet", () => {
    const list = listWith([{ index: 2, top: 200, bottom: 220 }]);
    keepSelectionClear(list, range(2, 2));
    expect(list.scrollTop).toBe(0);
  });

  it("gives the room back when no sheet is open", () => {
    const list = listWith([{ index: 2, top: 200, bottom: 220 }]);
    keepSelectionClear(list, range(2, 2));
    expect(list.style.getPropertyValue("--sheet-clearance")).toBe("300px");
    sheet.top = null;
    keepSelectionClear(list, range(2, 2));
    expect(list.style.getPropertyValue("--sheet-clearance")).toBe("");
  });

  it("scrolls the ancestor that can move the range when the list cannot", () => {
    const outer = document.createElement("div");
    outer.getBoundingClientRect = () => rect(0, 700);
    const list = listWith([{ index: 2, top: 380, bottom: 420 }]);
    list.getBoundingClientRect = () => rect(300, 700);
    Object.defineProperty(list, "scrollHeight", { value: 400 });
    Object.defineProperty(list, "clientHeight", { value: 400 });
    Object.defineProperty(outer, "scrollHeight", { value: 1200 });
    Object.defineProperty(outer, "clientHeight", { value: 700 });
    outer.style.overflowY = "auto";
    Object.defineProperty(list, "scrollTop", { get: () => 0, set: () => {} });
    outer.append(list);
    document.body.append(outer);
    keepSelectionClear(list, range(2, 2));
    expect(list.scrollTop).toBe(0);
    expect(outer.scrollTop).toBe(420 - (400 - KEEP_CLEAR_PX));
    outer.remove();
  });

  it("measures the sheet against the visual viewport, which the keypad or toolbar can shorten", () => {
    vi.stubGlobal("visualViewport", { offsetTop: 0, height: 300 });
    const list = listWith([{ index: 2, top: 300, bottom: 320 }]);
    list.getBoundingClientRect = () => rect(100, 700);
    keepSelectionClear(list, range(2, 2));
    expect(list.scrollTop).toBe(320 - (300 - KEEP_CLEAR_PX));
  });

  it("caps the sheet just under the range when the list top is already below the sheet top", () => {
    sheet.top = 362;
    const list = listWith([{ index: 2, top: 400, bottom: 420 }]);
    list.getBoundingClientRect = () => rect(385, 700);
    keepSelectionClear(list, range(2, 2));
    const scrolled = list.scrollTop;
    expect(scrolled).toBe(15);
    expect(sheet.cap).toBe(800 - (420 - scrolled + KEEP_CLEAR_PX));
  });

  it("never caps the sheet below one readable strip", () => {
    sheet.top = 362;
    const list = listWith([{ index: 2, top: 740, bottom: 760 }]);
    list.getBoundingClientRect = () => rect(385, 790);
    keepSelectionClear(list, range(2, 2));
    expect(sheet.cap).toBeGreaterThanOrEqual(144);
  });

  it("leaves the sheet alone when scrolling clears the range", () => {
    const list = listWith([{ index: 2, top: 420, bottom: 440 }]);
    keepSelectionClear(list, range(2, 2));
    expect(sheet.cap).toBeNull();
  });

  it("lifts the cap once the viewport grows and the range clears", () => {
    sheet.top = 362;
    const list = listWith([{ index: 2, top: 400, bottom: 420 }]);
    list.getBoundingClientRect = () => rect(385, 700);
    keepSelectionClear(list, range(2, 2));
    expect(sheet.cap).not.toBeNull();
    sheet.top = 100;
    list.getBoundingClientRect = () => rect(0, 700);
    keepSelectionClear(list, range(2, 2));
    expect(sheet.cap).toBeNull();
  });

  it("lifts the cap when the keypad that shortened the viewport closes", () => {
    const viewport = new EventTarget() as EventTarget & {
      offsetTop: number;
      height: number;
    };
    viewport.offsetTop = 0;
    viewport.height = 300;
    vi.stubGlobal("visualViewport", viewport);
    sheet.top = 362;
    const list = listWith([{ index: 2, top: 400, bottom: 420 }]);
    list.getBoundingClientRect = () => rect(385, 700);
    const { unmount } = renderHook(() =>
      useKeepSelectionClear({ current: list }, range(2, 2)),
    );
    expect(sheet.cap).not.toBeNull();
    viewport.height = 844;
    sheet.top = 100;
    list.getBoundingClientRect = () => rect(0, 700);
    viewport.dispatchEvent(new Event("resize"));
    expect(sheet.cap).toBeNull();
    unmount();
  });
});
