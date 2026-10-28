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
        "view.fit": ["B"],
      }),
    );
    expect(getKeymapOverride("focus.timeline")).toBeUndefined();
    expect(getKeymapOverride("focus.cycle")).toBeUndefined();
    expect(getKeymapOverride("layout.text")).toBeUndefined();
    expect(getKeymapOverride("view.fit")).toEqual(["B"]);
    expect(stored()).toEqual({ "view.fit": ["B"] });
  });

  it("drops saved remaps for the removed tool and comment-mode commands", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        "tool.select": ["B"],
        "tool.blade": ["X"],
        "review.toggleCommentMode": ["N"],
        "review.exitCommentMode": ["Q"],
        "view.fit": ["F"],
      }),
    );
    for (const id of [
      "tool.select",
      "tool.blade",
      "review.toggleCommentMode",
      "review.exitCommentMode",
    ])
      expect(getKeymapOverride(id)).toBeUndefined();
    expect(getKeymapOverride("view.fit")).toEqual(["F"]);
    expect(stored()).toEqual({ "view.fit": ["F"] });
  });

  it("leaves a map without renamed ids untouched", () => {
    localStorage.setItem(KEY, JSON.stringify({ "view.fit": ["B"] }));
    expect(getKeymapOverride("view.fit")).toEqual(["B"]);
  });

  it.each(["null", "[]", "42", '"x"', "{not json"])(
    "treats a stored %s as no remaps",
    (raw) => {
      localStorage.setItem(KEY, raw);
      expect(getKeymapOverride("view.fit")).toBeUndefined();
      expect(getKeymapOverride("layout.timeline")).toBeUndefined();
    },
  );
});
