import { render, within } from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ToggleButton } from "./ToggleButton";

describe("ToggleButton", () => {
  it("exposes aria-pressed when unpressed and is axe-clean", async () => {
    const { container } = render(
      <ToggleButton pressed={false}>Comments</ToggleButton>,
    );
    const btn = within(container).getByRole("button", { name: "Comments" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveClass("ui-control");
    expect(btn).not.toHaveClass("active");
    await expectNoA11yViolations(container);
  });

  it("exposes aria-pressed when pressed and is axe-clean", async () => {
    const { container } = render(<ToggleButton pressed>Comments</ToggleButton>);
    const btn = within(container).getByRole("button", { name: "Comments" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveClass("ui-control", "active");
    await expectNoA11yViolations(container);
  });

  it("quiet variant adds ui-control--quiet", () => {
    const { container } = render(
      <ToggleButton pressed={false} quiet>
        Transcript
      </ToggleButton>,
    );
    expect(
      within(container).getByRole("button", { name: "Transcript" }),
    ).toHaveClass("ui-control", "ui-control--quiet");
  });

  it("forces aria-pressed from pressed even if rest tries to override", () => {
    const sneaky = {
      "aria-pressed": "false",
    } as ButtonHTMLAttributes<HTMLButtonElement>;
    const { container } = render(
      <ToggleButton pressed {...sneaky}>
        Comments
      </ToggleButton>,
    );
    expect(
      within(container).getByRole("button", { name: "Comments" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
