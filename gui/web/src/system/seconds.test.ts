import { describe, expect, it } from "vitest";
import { formatCutsSaved, formatSeconds } from "./seconds";

describe("formatCutsSaved", () => {
  it.each([
    [0, "No cuts yet"],
    [-1, "No cuts yet"],
    [Number.NaN, "No cuts yet"],
    [Number.POSITIVE_INFINITY, "No cuts yet"],
    [Number.NEGATIVE_INFINITY, "No cuts yet"],
    [0.04, "No cuts yet"],
    [0.05, "0.1 s shorter"],
    [3.2, "3.2 s shorter"],
    [4.5, "4.5 s shorter"],
    [9.94, "9.9 s shorter"],
    [9.96, "10 s shorter"],
    [10, "10 s shorter"],
    [12.4, "12 s shorter"],
    [23.6, "24 s shorter"],
    [59.4, "59 s shorter"],
    [59.6, "1 min shorter"],
    [72, "1 min 12 s shorter"],
    [119.5, "2 min shorter"],
    [3725, "62 min 5 s shorter"],
  ])("%s reads %j", (sec, text) => {
    expect(formatCutsSaved(sec)).toBe(text);
  });

  it("never shows a trailing .0 or a 60 s", () => {
    for (const sec of [9.96, 10, 59.6, 119.5, 3600]) {
      expect(formatCutsSaved(sec)).not.toMatch(/\.0|60 s/);
    }
  });
});

describe("formatSeconds", () => {
  it("keeps one decimal for the clips row", () => {
    expect(formatSeconds(2.94)).toBe("2.9 s");
    expect(formatSeconds(0)).toBe("0.0 s");
  });
});
