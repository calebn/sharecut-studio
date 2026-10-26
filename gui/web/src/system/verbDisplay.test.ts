import { describe, expect, it } from "vitest";
import { capsOf, hintOf, verbOf } from "./verbDisplay";

describe("capsOf", () => {
  it("shows the Apple modifiers on Apple platforms", () => {
    expect(capsOf({ key: "Z", mod: true, shift: true }, true)).toEqual([
      "⌘",
      "⇧",
      "Z",
    ]);
    expect(capsOf({ key: "K", alt: true }, true)).toEqual(["⌥", "K"]);
  });

  it("shows Ctrl and Alt elsewhere", () => {
    expect(capsOf({ key: "Z", mod: true }, false)).toEqual(["Ctrl", "Z"]);
    expect(capsOf({ key: "K", alt: true }, false)).toEqual(["Alt", "K"]);
  });

  it("names the special keys", () => {
    expect(capsOf({ key: "Backspace" }, false)).toEqual(["⌫"]);
    expect(capsOf({ key: "Enter", shift: true }, false)).toEqual(["⇧", "↵"]);
    expect(capsOf({ key: "ArrowUp" }, false)).toEqual(["↑"]);
    expect(capsOf({ key: "Space" }, false)).toEqual(["Space"]);
  });
});

describe("hintOf", () => {
  it("writes the first chord as a tooltip suffix", () => {
    expect(hintOf(verbOf("play"))).toBe(" (Space)");
  });

  it("is empty for a verb with no key", () => {
    expect(hintOf(verbOf("invite"))).toBe("");
  });
});

describe("verbOf", () => {
  it("returns the row by id", () => {
    expect(verbOf("cut").label).toBe("Cut");
  });

  it("throws on an unknown id", () => {
    expect(() => verbOf("nope" as never)).toThrow("Unknown verb nope");
  });
});
