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

  it("classifies zones from real dBFS thresholds, not decoration", () => {
    const { rerender, container } = render(<LevelMeter levelDb={-30} />);
    expect(
      container.querySelector(".ui-meter-fill")?.getAttribute("data-zone"),
    ).toBe("ok");
    rerender(<LevelMeter levelDb={-9} />);
    expect(
      container.querySelector(".ui-meter-fill")?.getAttribute("data-zone"),
    ).toBe("warn");
    rerender(<LevelMeter levelDb={-3} />);
    expect(
      container.querySelector(".ui-meter-fill")?.getAttribute("data-zone"),
    ).toBe("danger");
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
    const { getByRole, getByTestId } = render(
      <LevelMeter levelDb={-0.5} peakHoldDb={0} clipped />,
    );
    expect(getByTestId("clip-led").getAttribute("data-lit")).toBe("true");
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
