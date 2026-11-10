import { afterEach, describe, expect, it } from "vitest";
import { inspectorSheetPanel, inspectorSheetTop } from "./compactSheet";

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
  });
});

describe("the phone Inspector sheet", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is found by every keep-clear helper though it has no slot around it", () => {
    const panel = document.createElement("section");
    panel.className = "sys-inspector sys-inspector--phone";
    panel.getBoundingClientRect = () =>
      ({ top: 400, bottom: 800, height: 400 }) as DOMRect;
    document.body.append(panel);
    expect(inspectorSheetPanel()).toBe(panel);
    expect(inspectorSheetTop()).toBe(400);
  });
});
