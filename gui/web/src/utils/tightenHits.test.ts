import { describe, expect, it } from "vitest";
import { isTightenClass } from "./tightenHits";

describe("isTightenClass", () => {
  it("knows every tighten proposal class", () => {
    for (const kind of ["filler", "pause", "repeat", "false-start", "sound"]) {
      expect(isTightenClass(kind)).toBe(true);
    }
  });

  it("does not take other, an absent kind or an unknown one", () => {
    expect(isTightenClass("other")).toBe(false);
    expect(isTightenClass(undefined)).toBe(false);
    expect(isTightenClass("mystery")).toBe(false);
    expect(isTightenClass("toString")).toBe(false);
  });
});
