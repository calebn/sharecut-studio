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
});
