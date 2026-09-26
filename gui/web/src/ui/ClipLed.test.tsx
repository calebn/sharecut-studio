import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ClipLed } from "./ClipLed";

describe("ClipLed", () => {
  it("is decorative without a label", () => {
    render(<ClipLed lit={false} showText />);
    const led = screen.getByTestId("clip-led");
    expect(led.getAttribute("aria-hidden")).toBe("true");
    expect(led.getAttribute("data-lit")).toBe("false");
    expect(led.textContent).toBe("Clip");
  });

  it("shows Clipped text when lit", () => {
    render(<ClipLed lit showText />);
    expect(screen.getByTestId("clip-led").textContent).toBe("Clipped");
  });

  it("omits text by default", () => {
    render(<ClipLed lit />);
    expect(screen.getByTestId("clip-led").textContent).toBe("");
  });

  it("exposes a labelled image and is axe-clean", async () => {
    const { container, rerender } = render(<ClipLed lit label="Take" />);
    expect(
      screen.getByRole("img", { name: "Take: clipping detected" }),
    ).toBeTruthy();
    rerender(<ClipLed lit={false} label="Take" />);
    expect(screen.getByRole("img", { name: "Take: no clipping" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });
});
