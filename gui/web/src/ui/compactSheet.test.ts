import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capInspectorSheet,
  capInspectorSheetForLane,
  chromePins,
  editedLaneTrack,
  halfDetentFits,
  inspectorSheetBottom,
  inspectorSheetPanel,
  inspectorSheetTop,
  measureCompactFit,
} from "./compactSheet";

describe("editedLaneTrack", () => {
  it("names the track of an envelope selection, and no other", () => {
    expect(editedLaneTrack({ kind: "envelope", trackId: "host" })).toBe("host");
    expect(
      editedLaneTrack({
        kind: "envelopePoint",
        trackId: "guest",
        pointId: "p",
      }),
    ).toBe("guest");
    expect(editedLaneTrack({ kind: "track", trackId: "host" })).toBeNull();
    expect(editedLaneTrack(null)).toBeNull();
  });
});

describe("capInspectorSheet", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the lane cap apart from the transcript's, so one owner cannot lift the other", () => {
    const panel = document.createElement("div");
    panel.className = "bottom-sheet--inspector";
    document.body.append(panel);
    capInspectorSheetForLane(144.4);
    capInspectorSheet(200);
    expect(panel.style.getPropertyValue("--sheet-lane-cap")).toBe("144px");
    expect(panel.style.getPropertyValue("--sheet-cap")).toBe("200px");
    capInspectorSheet(null);
    expect(panel.style.getPropertyValue("--sheet-lane-cap")).toBe("144px");
    expect(panel.style.getPropertyValue("--sheet-cap")).toBe("");
  });
});

describe("the Inspector column", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is invisible to every keep-clear helper, which look for the sheet class", () => {
    const panel = document.createElement("div");
    panel.className = "bottom-sheet bottom-sheet--column";
    document.body.append(panel);
    expect(inspectorSheetPanel()).toBeNull();
    expect(inspectorSheetTop()).toBeNull();
    expect(inspectorSheetBottom()).toBeNull();
    capInspectorSheet(120);
    capInspectorSheetForLane(120);
    expect(panel.style.getPropertyValue("--sheet-cap")).toBe("");
    expect(panel.style.getPropertyValue("--sheet-lane-cap")).toBe("");
  });
});

describe("halfDetentFits", () => {
  it("fits when half the slot holds the chrome and one touch row", () => {
    expect(halfDetentFits(424, 112, 88)).toBe(true);
    expect(halfDetentFits(400, 112, 88)).toBe(true);
  });

  it("is denied one pixel short of the chrome plus one row", () => {
    expect(halfDetentFits(399, 112, 88)).toBe(false);
    expect(halfDetentFits(212, 112, 88)).toBe(false);
  });

  it("fits a slot that is not laid out yet", () => {
    expect(halfDetentFits(0, 112, 88)).toBe(true);
    expect(halfDetentFits(Number.NaN, 112, 88)).toBe(true);
  });
});

describe("chromePins", () => {
  it("pins the chrome while the slot holds it and one touch row", () => {
    expect(chromePins(200, 112, 88)).toBe(true);
    expect(chromePins(199, 112, 88)).toBe(false);
    expect(chromePins(120, 121, 88)).toBe(false);
  });

  it("pins in a slot that is not laid out yet", () => {
    expect(chromePins(0, 112, 88)).toBe(true);
  });
});

describe("measureCompactFit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function mount(slot: number, headerRows: number) {
    document.body.innerHTML = `
      <div class="bottom-sheet-root">
        <div class="bottom-sheet bottom-sheet--compact">
          <div class="bottom-sheet-chrome">
            <div class="bottom-sheet-header" style="padding: 8px 0">
              <button class="dialog-close"></button>
            </div>
          </div>
        </div>
      </div>`;
    const height = (el: Element) => {
      if (el.classList.contains("bottom-sheet-root"))
        return { top: 0, h: slot };
      if (el.classList.contains("bottom-sheet-chrome"))
        return { top: 0, h: 8 + headerRows * 104 };
      if (el.classList.contains("bottom-sheet-header"))
        return { top: 8, h: headerRows * 104 };
      if (el.classList.contains("dialog-close")) return { top: 16, h: 88 };
      return {
        top: 0,
        h: el.getAttribute("style")?.includes("--touch-min") ? 88 : 0,
      };
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const { top, h } = height(this);
        return { top, bottom: top + h, height: h } as DOMRect;
      },
    );
  }

  it("is null with no sheet open", () => {
    expect(measureCompactFit(true)).toBeNull();
  });

  it("denies the half detent of a folded frame by the one-row header, not the wrapped one", () => {
    mount(250, 2);
    expect(measureCompactFit(true)).toEqual({
      halfFits: false,
      pinsChrome: false,
    });
    mount(450, 2);
    expect(measureCompactFit(true)).toEqual({
      halfFits: true,
      pinsChrome: true,
    });
  });

  it("keeps the half detent of a frame that is not folded", () => {
    mount(150, 1);
    expect(measureCompactFit(false)).toEqual({
      halfFits: true,
      pinsChrome: false,
    });
  });
});
