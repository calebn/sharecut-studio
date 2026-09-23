import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { LevelMeter } from "./LevelMeter";

describe("LevelMeter", () => {
  it("exposes meter semantics with the dBFS range", () => {
    const { getByRole } = render(
      <LevelMeter levelDb={-12} label="Host input" />,
    );
    const meter = getByRole("meter", { name: "Host input" });
    expect(meter.getAttribute("aria-valuemin")).toBe("-60");
    expect(meter.getAttribute("aria-valuemax")).toBe("0");
    expect(meter.getAttribute("aria-valuenow")).toBe("-12");
    expect(meter.getAttribute("aria-valuetext")).toBe("-12 dBFS");
  });

  it("tags the root with the dBFS zone that tints the numeric readout", () => {
    const { rerender, getByRole } = render(<LevelMeter levelDb={-30} />);
    expect(getByRole("meter").getAttribute("data-zone")).toBe("ok");
    rerender(<LevelMeter levelDb={-9} />);
    expect(getByRole("meter").getAttribute("data-zone")).toBe("warn");
    rerender(<LevelMeter levelDb={-3} />);
    expect(getByRole("meter").getAttribute("data-zone")).toBe("danger");
  });

  it("clamps aria-valuenow into range but keeps the true reading in valuetext", () => {
    const { rerender, getByRole } = render(<LevelMeter levelDb={-72} />);
    expect(getByRole("meter").getAttribute("aria-valuenow")).toBe("-60");
    expect(getByRole("meter").getAttribute("aria-valuetext")).toBe("-72 dBFS");
    rerender(<LevelMeter levelDb={0.5} />);
    expect(getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
  });

  it("hides the peak-hold tick when nothing is held", () => {
    const { queryByTestId } = render(
      <LevelMeter levelDb={-30} peakHoldDb={Number.NEGATIVE_INFINITY} />,
    );
    expect(queryByTestId("peak-hold")).toBeNull();
  });

  it("pins scale end labels by value, not DOM order", () => {
    const { container, rerender } = render(
      <LevelMeter levelDb={-30} showScale />,
    );
    const edges = () =>
      [...container.querySelectorAll(".ui-meter-tick")].map((el) => [
        el.textContent,
        el.getAttribute("data-edge"),
      ]);
    expect(edges()[0]).toEqual(["0", "max"]);
    expect(edges().at(-1)).toEqual(["-60", "min"]);
    expect(edges()[3]).toEqual(["-30", null]);
    rerender(<LevelMeter levelDb={-30} minDb={-48} showScale />);
    // -48 has no tick, so the last (-40) label stays centered.
    expect(edges().at(-1)).toEqual(["-40", null]);
  });

  it("fills proportionally: -30 dBFS reveals half the track on a -60 scale", () => {
    const { container } = render(<LevelMeter levelDb={-30} />);
    expect(
      container.querySelector(".ui-meter-fill")?.getAttribute("style"),
    ).toContain("inset(0 50% 0 0)");
  });

  it("renders the peak-hold tick above the current level", () => {
    const { getByTestId } = render(
      <LevelMeter levelDb={-30} peakHoldDb={-15} />,
    );
    // -15 dBFS is 75% up a -60 scale
    expect(getByTestId("peak-hold").getAttribute("style")).toContain(
      "calc(75% - var(--meter-hold-offset))",
    );
  });

  it("latches the clip LED and announces clipping", () => {
    const { getByRole, getByTestId, rerender } = render(
      <LevelMeter levelDb={-12} label="Host input" />,
    );
    expect(getByTestId("clip-led").textContent).toBe("Clip");
    expect(getByRole("status").textContent).toBe("");
    rerender(
      <LevelMeter levelDb={-0.5} peakHoldDb={0} clipped label="Host input" />,
    );
    expect(getByTestId("clip-led").getAttribute("data-lit")).toBe("true");
    // Not colour alone (WCAG 1.4.1): the text changes when lit.
    expect(getByTestId("clip-led").textContent).toBe("Clipped");
    expect(getByRole("status").textContent).toBe("Host input: clipping");
    expect(getByRole("meter").getAttribute("aria-valuetext")).toContain(
      "Clipping",
    );
  });

  it("renders silence as an empty meter, not a broken one", () => {
    const { getByRole, container } = render(
      <LevelMeter levelDb={Number.NEGATIVE_INFINITY} />,
    );
    expect(getByRole("meter").getAttribute("aria-valuenow")).toBe("-60");
    expect(getByRole("meter").getAttribute("aria-valuetext")).toBe("-∞ dBFS");
    expect(
      container.querySelector(".ui-meter-fill")?.getAttribute("style"),
    ).toContain("inset(0 100% 0 0)");
  });

  it("supports vertical orientation", () => {
    const { container } = render(
      <LevelMeter levelDb={-12} orientation="vertical" />,
    );
    expect(container.querySelector(".ui-meter--vertical")).toBeTruthy();
  });

  it("is axe-clean in quiet, hot, and clipped states", async () => {
    for (const levelDb of [-42, -4]) {
      const { container, unmount } = render(
        <LevelMeter levelDb={levelDb} peakHoldDb={-2} showNumeric showScale />,
      );
      await expectNoA11yViolations(container);
      unmount();
    }
    const { container } = render(
      <LevelMeter levelDb={-0.5} clipped showNumeric showScale />,
    );
    await expectNoA11yViolations(container);
  });
});
