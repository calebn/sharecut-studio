import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { CloseButton } from "./CloseButton";

describe("CloseButton", () => {
  it("is named Close and defaults to a type=button with the Esc hint", () => {
    render(<CloseButton />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("title", "Close (Esc)");
  });

  it("appends a custom className to the shared dialog-close class", () => {
    render(<CloseButton className="x" />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "ui-control dialog-close x",
    );
  });

  it("lets a custom title override the default", () => {
    render(<CloseButton title="Dismiss" />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute(
      "title",
      "Dismiss",
    );
  });

  it("is axe-clean", async () => {
    const { container } = render(<CloseButton />);
    await expectNoA11yViolations(container);
  });
});
