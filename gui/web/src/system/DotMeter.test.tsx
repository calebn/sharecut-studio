import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { DotMeter } from "./DotMeter";

describe("DotMeter dot count", () => {
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
  ])("maps %s to %s filled dots", (value, filled) => {
    render(<DotMeter label="Confidence" value={value} />);
    const meter = screen.getByRole("img", {
      name: `Confidence ${filled} of 5`,
    });
    expect(meter.querySelectorAll("[data-filled]")).toHaveLength(filled);
  });
});

describe("DotMeter", () => {
  it("draws five dots and names the filled count without the number", async () => {
    const { container } = render(<DotMeter label="Confidence" value={0.62} />);
    const meter = screen.getByRole("img", { name: "Confidence 3 of 5" });
    expect(meter.querySelectorAll(".sys-dots-dot")).toHaveLength(5);
    expect(meter.querySelectorAll("[data-filled]")).toHaveLength(3);
    expect(container).not.toHaveTextContent("0.62");
    await expectNoA11yViolations(container);
  });

  it("names a Quality score of 0.87 as four of five", async () => {
    const { container } = render(<DotMeter label="Quality" value={0.87} />);
    const meter = screen.getByRole("img", { name: "Quality 4 of 5" });
    expect(meter.querySelectorAll("[data-filled]")).toHaveLength(4);
    await expectNoA11yViolations(container);
  });

  it("prints its label by default and hides it on request", () => {
    const { rerender } = render(<DotMeter label="Quality" value={0.5} />);
    expect(
      screen.getByRole("img", { name: "Quality 3 of 5" }),
    ).toHaveTextContent("Quality");
    rerender(<DotMeter label="Quality" value={0.5} showLabel={false} />);
    expect(
      screen.getByRole("img", { name: "Quality 3 of 5" }).textContent,
    ).toBe("");
  });
});
