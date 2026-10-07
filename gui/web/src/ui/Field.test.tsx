import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Field } from "./Field";

describe("Field", () => {
  it("labels, describes and invalidates its control without caller ids", async () => {
    const { container } = render(
      <Field label="Name" hint="Required" error="Too short">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAccessibleDescription("Required Too short");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short");
    await expectNoA11yViolations(container);
  });

  it("drops the error wiring once the error clears", () => {
    const { rerender } = render(
      <Field label="Name" hint="Required" error="Too short">
        {(control) => <input {...control} />}
      </Field>,
    );
    rerender(
      <Field label="Name" hint="Required">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAccessibleDescription("Required");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives a bare control no description", () => {
    render(<Field label="Name">{(control) => <input {...control} />}</Field>);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("keeps two fields' ids apart", () => {
    render(
      <>
        <Field label="Start" error="Too early">
          {(control) => <input {...control} />}
        </Field>
        <Field label="End" error="Too late">
          {(control) => <input {...control} />}
        </Field>
      </>,
    );
    expect(
      screen.getByRole("textbox", { name: "Start" }),
    ).toHaveAccessibleDescription("Too early");
    expect(
      screen.getByRole("textbox", { name: "End" }),
    ).toHaveAccessibleDescription("Too late");
  });
});
