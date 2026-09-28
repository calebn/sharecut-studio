import { describe, expect, it } from "vitest";
import { fadeCurvePaths, fadeCurveViewBox } from "./fadeCurvePaths";

describe("fadeCurvePaths", () => {
  it("draws a fade-in ramp", () => {
    expect(fadeCurvePaths(100, 20, 0)).toEqual({
      dim: ["M0 0H20L0 100Z"],
      lines: ["M0 100L20 0"],
    });
  });

  it("draws a fade-out ramp", () => {
    expect(fadeCurvePaths(100, 0, 30)).toEqual({
      dim: ["M70 0H100V100Z"],
      lines: ["M70 0L100 100"],
    });
  });

  it("clamps lengths to the width and to 0", () => {
    expect(fadeCurvePaths(50, 80, -5).lines).toEqual(["M0 100L50 0"]);
  });

  it("rounds to 0.01 px", () => {
    expect(fadeCurvePaths(100, 1 / 3, 0).lines).toEqual(["M0 100L0.33 0"]);
  });
});

describe("fadeCurveViewBox", () => {
  it("is widthPx × 100, at least 1 px wide, rounded to 0.01 px", () => {
    expect(fadeCurveViewBox(100)).toBe("0 0 100 100");
    expect(fadeCurveViewBox(0)).toBe("0 0 1 100");
    expect(fadeCurveViewBox(10 + 1 / 3)).toBe("0 0 10.33 100");
  });
});
