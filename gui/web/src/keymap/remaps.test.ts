import { beforeEach, describe, expect, it } from "vitest";
import { _resetKeymapOverridesForTests, getKeymapOverride } from "./remaps";

const KEY = "sharecut.keymap.overrides";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;

describe("keymap remaps", () => {
  beforeEach(() => _resetKeymapOverridesForTests());

  it("moves saved focus.* remaps to layout.* and drops focus.cycle", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "focus.timeline": ["G"],
        "focus.cycle": ["F"],
        "tool.select": ["B"],
      }),
    );
    expect(getKeymapOverride("layout.timeline")).toEqual(["G"]);
    expect(getKeymapOverride("focus.timeline")).toBeUndefined();
    expect(getKeymapOverride("focus.cycle")).toBeUndefined();
    expect(getKeymapOverride("tool.select")).toEqual(["B"]);
    expect(stored()).toEqual({
      "layout.timeline": ["G"],
      "tool.select": ["B"],
    });
  });

  it("keeps an existing layout.* remap over the old focus.* one", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ "focus.text": ["T"], "layout.text": ["Y"] }),
    );
    expect(getKeymapOverride("layout.text")).toEqual(["Y"]);
    expect(stored()).toEqual({ "layout.text": ["Y"] });
  });

  it("leaves a map without renamed ids untouched", () => {
    localStorage.setItem(KEY, JSON.stringify({ "tool.select": ["B"] }));
    expect(getKeymapOverride("tool.select")).toEqual(["B"]);
  });
});
