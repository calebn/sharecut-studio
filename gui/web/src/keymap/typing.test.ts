import { describe, expect, it } from "vitest";
import { hasCommandModifier } from "./typing";

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
