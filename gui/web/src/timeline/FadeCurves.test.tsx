import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { FadeCurves } from "./FadeCurves";

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
