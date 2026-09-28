import { describe, expect, it } from "vitest";
import { wordInteractionTip, wordSeekLabel } from "./wordInteractionTip";

describe("wordSeekLabel", () => {
  it("formats 0 as 0:00.0", () => {
    expect(wordSeekLabel(0)).toBe("0:00.0");
  });

  it("formats 62.34 as 1:02.3", () => {
    expect(wordSeekLabel(62.34)).toBe("1:02.3");
  });
});

describe("wordInteractionTip", () => {
  it("navigate mode: double-click to seek when not inline-editable", () => {
    expect(
      wordInteractionTip({
        intent: "navigate",
        wordIndex: 3,
        seekSec: 0,
        inlineEditable: false,
      }),
    ).toBe("Double-click to seek to 0:00.0");
  });

  it("navigate mode: click to seek, double-click to fix text when inline-editable", () => {
    expect(
      wordInteractionTip({
        intent: "navigate",
        wordIndex: 3,
        seekSec: 62.34,
        inlineEditable: true,
      }),
    ).toBe("Click to seek to 1:02.3 · Double-click to fix text");
  });

  it("navigate mode with a null seek is undefined", () => {
    expect(
      wordInteractionTip({
        intent: "navigate",
        wordIndex: 3,
        seekSec: null,
        inlineEditable: true,
      }),
    ).toBeUndefined();
  });

  it("correct intent with a word index", () => {
    expect(
      wordInteractionTip({
        intent: "correct",
        wordIndex: 1,
        seekSec: 5,
        inlineEditable: false,
      }),
    ).toBe("Click to select for Correct · Double-click to seek");
  });

  it("correct intent without a word index is undefined", () => {
    expect(
      wordInteractionTip({
        intent: "correct",
        wordIndex: null,
        seekSec: 5,
        inlineEditable: false,
      }),
    ).toBeUndefined();
  });

  it("select intent with a word index", () => {
    expect(
      wordInteractionTip({
        intent: "select",
        wordIndex: 1,
        seekSec: 5,
        inlineEditable: false,
      }),
    ).toBe(
      "Click or drag to select a range · Shift+click to extend · Double-click to seek",
    );
  });

  it("select intent without a word index is undefined", () => {
    expect(
      wordInteractionTip({
        intent: "select",
        wordIndex: undefined,
        seekSec: 5,
        inlineEditable: false,
      }),
    ).toBeUndefined();
  });
});
