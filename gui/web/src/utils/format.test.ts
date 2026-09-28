import { describe, expect, it } from "vitest";
import { capitalize, joinSentences, overflowLabel, plural } from "./format";

describe("plural", () => {
  it("returns the singular form when count is 1", () => {
    expect(plural(1, "chunk")).toBe("chunk");
  });

  it("returns the plural form when count is 0 or greater than 1", () => {
    expect(plural(0, "chunk")).toBe("chunks");
    expect(plural(2, "chunk")).toBe("chunks");
  });

  it("uses an explicit plural form when given one", () => {
    expect(plural(2, "child", "children")).toBe("children");
    expect(plural(1, "child", "children")).toBe("child");
  });
});

describe("overflowLabel", () => {
  it("prefixes the hidden count with + and ends with more", () => {
    expect(overflowLabel(1)).toBe("+1 more");
    expect(overflowLabel(12)).toBe("+12 more");
  });
});

describe("capitalize", () => {
  it("upper-cases the first character", () => {
    expect(capitalize("medium")).toBe("Medium");
    expect(capitalize("")).toBe("");
  });
});

describe("joinSentences", () => {
  it("joins non-empty parts with period-space", () => {
    expect(joinSentences(["A", "B"])).toBe("A. B");
  });
  it("drops empty, null, undefined and false parts", () => {
    expect(joinSentences(["A", "", null, undefined, false, "B"])).toBe("A. B");
    expect(joinSentences([])).toBe("");
  });
});
