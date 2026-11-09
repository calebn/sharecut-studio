import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ConfidenceMeter } from "./ConfidenceMeter";

describe("ConfidenceMeter dot count", () => {
  it.each([
    [0, 0],
    [0.09, 0],
    [0.1, 1],
    [0.31, 2],
    [0.5, 3],
    [0.9, 5],
    [1, 5],
    [1.4, 5],
    [-1, 0],
    [Number.NaN, 0],
  ])("maps %s to %s filled dots", (confidence, filled) => {
    render(<ConfidenceMeter confidence={confidence} />);
    const meter = screen.getByRole("img", {
      name: `Confidence ${filled} of 5`,
    });
    expect(meter.querySelectorAll("[data-filled]")).toHaveLength(filled);
  });
});

describe("ConfidenceMeter", () => {
  it("draws five dots and names the filled count without the number", async () => {
    const { container } = render(<ConfidenceMeter confidence={0.62} />);
    const meter = screen.getByRole("img", { name: "Confidence 3 of 5" });
    expect(meter.querySelectorAll(".sys-confidence-dot")).toHaveLength(5);
    expect(meter.querySelectorAll("[data-filled]")).toHaveLength(3);
    expect(container).not.toHaveTextContent("0.62");
    await expectNoA11yViolations(container);
  });
});
