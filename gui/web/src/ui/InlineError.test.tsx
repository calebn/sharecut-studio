import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { InlineError } from "./InlineError";

describe("InlineError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<InlineError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces a paragraph as an alert", () => {
    render(<InlineError message="Nope" />);
    const el = screen.getByRole("alert");
    expect(el.tagName).toBe("P");
    expect(el).toHaveTextContent("Nope");
    expect(el).toHaveClass("inline-error", "pipeline-error");
  });

  it("announces an inline span with the id a control points at", async () => {
    const { container } = render(
      <p>
        <InlineError inline id="err" message="Nope" />
      </p>,
    );
    const el = screen.getByRole("alert");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveAttribute("id", "err");
    await expectNoA11yViolations(container);
  });
});
