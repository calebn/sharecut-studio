import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_CLEAR_PX } from "../layout/useCompactInspector";
import { keepSelectionClear } from "./useKeepSelectionClear";

const sheet = vi.hoisted(() => ({ top: null as number | null }));
vi.mock("../ui/compactSheet", () => ({
  inspectorSheetTop: () => sheet.top,
  inspectorSheetPanel: () => null,
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
    keepSelectionClear(list, {
      kind: "transcriptWord",
      trackId: "guest",
      wordIndex: 2,
    });
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
});
