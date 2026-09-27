import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { InlineError } from "./InlineError";

describe("InlineError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<InlineError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a paragraph by default", () => {
    render(<InlineError message="Nope" />);
    const el = screen.getByText("Nope");
    expect(el.tagName).toBe("P");
    expect(el).toHaveClass("inline-error", "pipeline-error");
  });

  it("renders an inline span with id and role", async () => {
    const { container } = render(
      <p>
        <InlineError inline id="err" role="alert" message="Nope" />
      </p>,
    );
    const el = screen.getByRole("alert");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveAttribute("id", "err");
    expect(el).toHaveClass("pipeline-error");
    await expectNoA11yViolations(container);
  });
});
