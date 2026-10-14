import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Button, type ButtonVariant } from "./Button";

const variants: ButtonVariant[] = ["default", "primary", "danger", "link"];

describe("Button", () => {
  it.each(variants)("variant %s is axe-clean", async (variant) => {
    const { container } = render(<Button variant={variant}>Save</Button>);
    expect(within(container).getByRole("button", { name: "Save" })).toHaveClass(
      "ui-control",
    );
    await expectNoA11yViolations(container);
  });

  it("disabled state is axe-clean", async () => {
    const { container } = render(
      <Button disabledReason="Name the episode to save." variant="primary">
        Save
      </Button>,
    );
    expect(
      within(container).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("describes a disabled button by its reason", () => {
    render(<Button disabledReason="Name the episode to save.">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Name the episode to save.");
    expect(button).toHaveAttribute("title", "Name the episode to save.");
  });

  it("has no native disabled prop, so a dead control needs a reason", () => {
    render(
      // @ts-expect-error `disabled` is omitted; pass `disabledReason`.
      <Button disabled>Save</Button>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
