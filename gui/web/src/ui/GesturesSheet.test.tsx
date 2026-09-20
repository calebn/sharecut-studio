import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { GesturesSheet } from "./GesturesSheet";

describe("GesturesSheet", () => {
  it("renders gesture list when open", () => {
    render(<GesturesSheet open={true} onClose={() => {}} />);
    expect(screen.getByText("Two-finger tap")).toBeInTheDocument();
    expect(screen.getByText("Long-press")).toBeInTheDocument();
    expect(screen.getByText("Pinch")).toBeInTheDocument();
  });

  it("marks unavailable gestures as coming soon", () => {
    render(<GesturesSheet open={true} onClose={() => {}} />);
    expect(screen.getAllByText("Soon").length).toBeGreaterThan(0);
  });

  it("does not render when closed", () => {
    const { container } = render(
      <GesturesSheet open={false} onClose={() => {}} />,
    );
    expect(container.textContent).not.toContain("Two-finger tap");
  });

  it("is axe-clean", async () => {
    const { container } = render(
      <GesturesSheet open={true} onClose={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
