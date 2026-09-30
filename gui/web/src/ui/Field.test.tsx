import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Field } from "./Field";

describe("Field", () => {
  it("renders label and is axe-clean", async () => {
    const { container } = render(
      <Field label="Name" htmlFor="name" hint="Required" error="Too short">
        <input id="name" />
      </Field>,
    );
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Too short")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("associates help and validation with the caller's control", () => {
    const { rerender } = render(
      <Field
        label="Name"
        htmlFor="name"
        hint="Required"
        hintId="name-hint"
        error="Too short"
        errorId="name-error"
      >
        <input id="name" aria-describedby="name-hint name-error" aria-invalid />
      </Field>,
    );
    expect(
      screen.getByRole("textbox", { name: "Name" }),
    ).toHaveAccessibleDescription("Required Too short");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    rerender(
      <Field label="Name" htmlFor="name" hint="Required" hintId="name-hint">
        <input id="name" aria-describedby="name-hint" />
      </Field>,
    );
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription("Required");
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Too short")).not.toBeInTheDocument();
  });
});
