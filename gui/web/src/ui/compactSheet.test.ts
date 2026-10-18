import { afterEach, describe, expect, it } from "vitest";
import {
  capInspectorSheet,
  capInspectorSheetForLane,
  editedLaneTrack,
  inspectorSheetBottom,
  inspectorSheetPanel,
  inspectorSheetTop,
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
