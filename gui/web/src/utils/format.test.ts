import { describe, expect, it } from "vitest";
import { formatElapsed, plural } from "./format";

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

describe("formatElapsed", () => {
  it("formats seconds as m:ss", () => {
    expect(formatElapsed(65)).toBe("1:05");
  });

  it("clamps negative values to 0:00", () => {
    expect(formatElapsed(-3)).toBe("0:00");
  });
});
