import { describe, expect, it } from "vitest";
import { hasCommandModifier, isButtonActivation } from "./typing";

const mods = (
  m: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

describe("isButtonActivation", () => {
  it("reserves bare Space and Enter for focused native buttons", () => {
    const button = document.createElement("button");
    for (const key of [" ", "Enter"]) {
      expect(
        isButtonActivation(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        ),
      ).toBe(false);
      button.addEventListener(
        "keydown",
        (event) => {
          expect(isButtonActivation(event)).toBe(true);
        },
        { once: true },
      );
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    }
    button.addEventListener(
      "keydown",
      (event) => {
        expect(isButtonActivation(event)).toBe(false);
      },
      { once: true },
    );
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", ctrlKey: true, bubbles: true }),
    );
  });
});

describe("hasCommandModifier", () => {
  it("is false for a bare key", () => {
    expect(hasCommandModifier(mods())).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "altKey"] as const)(
    "is true when %s is held",
    (key) => {
      expect(hasCommandModifier(mods({ [key]: true }))).toBe(true);
    },
  );

  it("does not treat Shift as a command modifier", () => {
    expect(hasCommandModifier(mods({ shiftKey: true }))).toBe(false);
  });
});
