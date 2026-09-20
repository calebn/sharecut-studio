import { render, within } from "@testing-library/react";
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
      <Button disabled variant="primary">
        Save
      </Button>,
    );
    expect(
      within(container).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    await expectNoA11yViolations(container);
  });
});
