import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReadoutChip } from "./ReadoutChip";

describe("ReadoutChip", () => {
  it("shows the delta before the resulting value", () => {
    const { container } = render(
      <ReadoutChip delta={"−120 ms"} value="12:04.340" />,
    );
    expect(container.textContent).toBe("−120 ms12:04.340");
  });

  it("leaves the delta out when there is none", () => {
    const { container } = render(<ReadoutChip value="−3.0 dB" />);
    expect(container.querySelector(".sys-readout-delta")).toBeNull();
  });

  it("says when the drag is at its limit", () => {
    render(<ReadoutChip value="500 ms" atLimit />);
    expect(screen.getByText("limit")).toBeInTheDocument();
  });

  it("follows the pointer when given a position and stays out of the accessibility tree", () => {
    const { container } = render(
      <ReadoutChip value="500 ms" at={{ x: 120, y: 40 }} />,
    );
    const chip = container.querySelector(".sys-readout") as HTMLElement;
    expect(chip.style.getPropertyValue("--sys-readout-x")).toBe("120px");
    expect(chip.style.getPropertyValue("--sys-readout-y")).toBe("40px");
    expect(chip).toHaveAttribute("aria-hidden", "true");
  });
});
