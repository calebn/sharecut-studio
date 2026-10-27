import { beforeEach, describe, expect, it } from "vitest";
import { _resetKeymapOverridesForTests, getKeymapOverride } from "./remaps";

const KEY = "sharecut.keymap.overrides";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;

describe("keymap remaps", () => {
  beforeEach(() => _resetKeymapOverridesForTests());

  it("drops saved remaps for the removed focus.* and layout.* commands", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "focus.timeline": ["G"],
        "focus.cycle": ["F"],
        "layout.text": ["Y"],
        "tool.select": ["B"],
      }),
    );
    expect(getKeymapOverride("focus.timeline")).toBeUndefined();
    expect(getKeymapOverride("focus.cycle")).toBeUndefined();
    expect(getKeymapOverride("layout.text")).toBeUndefined();
    expect(getKeymapOverride("tool.select")).toEqual(["B"]);
    expect(stored()).toEqual({ "tool.select": ["B"] });
  });

  it("leaves a map without renamed ids untouched", () => {
    localStorage.setItem(KEY, JSON.stringify({ "tool.select": ["B"] }));
    expect(getKeymapOverride("tool.select")).toEqual(["B"]);
  });

  it.each(["null", "[]", "42", '"x"', "{not json"])(
    "treats a stored %s as no remaps",
    (raw) => {
      localStorage.setItem(KEY, raw);
      expect(getKeymapOverride("tool.select")).toBeUndefined();
      expect(getKeymapOverride("layout.timeline")).toBeUndefined();
    },
  );
});
