import { describe, expect, it } from "vitest";
import { type ReviewKeyEvent, reviewActionFor } from "./reviewKeys";

const key = (
  k: string,
  over: Partial<ReviewKeyEvent> = {},
): ReviewKeyEvent => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("reviewActionFor", () => {
  it("maps the verb table keys", () => {
    expect(reviewActionFor(key("Enter"), {})).toBe("verb");
    expect(reviewActionFor(key("x"), {})).toBe("keep");
    expect(reviewActionFor(key("Tab"), {})).toBe("next");
    expect(reviewActionFor(key("ArrowDown"), {})).toBe("next");
    expect(reviewActionFor(key("Tab", { shiftKey: true }), {})).toBe(
      "previous",
    );
    expect(reviewActionFor(key("ArrowUp"), {})).toBe("previous");
    expect(reviewActionFor(key("a"), {})).toBe("hearBefore");
    expect(reviewActionFor(key("b"), {})).toBe("hearAfter");
    expect(reviewActionFor(key("Enter", { shiftKey: true }), {})).toBe(
      "applyAll",
    );
  });

  it("ignores editable targets", () => {
    const input = document.createElement("input");
    expect(reviewActionFor(key("x", { target: input }), {})).toBeNull();
  });

  it("leaves Tab and Enter to focused controls", () => {
    const button = document.createElement("button");
    expect(reviewActionFor(key("Tab", { target: button }), {})).toBeNull();
    expect(reviewActionFor(key("Enter", { target: button }), {})).toBeNull();
    expect(reviewActionFor(key("x", { target: button }), {})).toBe("keep");
  });

  it("uses Backspace as the verb only for a cut", () => {
    expect(reviewActionFor(key("Backspace"), { primary: "cut" })).toBe("verb");
    expect(reviewActionFor(key("Backspace"), { primary: "lower" })).toBeNull();
  });

  it("ignores chords with Ctrl or Meta", () => {
    expect(reviewActionFor(key("x", { metaKey: true }), {})).toBeNull();
  });
});
