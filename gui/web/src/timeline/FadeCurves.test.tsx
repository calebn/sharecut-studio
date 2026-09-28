import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { FadeCurves, fadeCurvePaths } from "./FadeCurves";

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

describe("FadeCurves", () => {
  it("renders both ramps as an aria-hidden svg overlay", async () => {
    const { container } = render(
      <div data-testid="host">
        <FadeCurves widthPx={100} inPx={20} outPx={30} />
      </div>,
    );
    const curves = container.querySelector(".clip-fade-curves");
    expect(curves?.getAttribute("aria-hidden")).toBe("true");
    const svg = curves?.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
    expect(container.querySelectorAll(".clip-fade-dim")).toHaveLength(2);
    expect(container.querySelectorAll(".clip-fade-line")).toHaveLength(2);
    await expectNoA11yViolations(container);
  });

  it("renders nothing with no fades", () => {
    const { getByTestId } = render(
      <div data-testid="host">
        <FadeCurves widthPx={100} inPx={0} outPx={0} />
      </div>,
    );
    expect(getByTestId("host").childElementCount).toBe(0);
  });
});
