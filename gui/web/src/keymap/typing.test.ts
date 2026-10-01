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
      const event = new KeyboardEvent("keydown", { key });
      Object.defineProperty(event, "target", { value: button });
      expect(isButtonActivation(event)).toBe(true);
    }
    const modifiedEvent = new KeyboardEvent("keydown", {
      key: " ",
      ctrlKey: true,
    });
    Object.defineProperty(modifiedEvent, "target", { value: button });
    expect(isButtonActivation(modifiedEvent)).toBe(false);

    expect(isButtonActivation(new KeyboardEvent("keydown", { key: " " }))).toBe(
      false,
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
