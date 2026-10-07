import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { InlineError } from "./InlineError";

describe("InlineError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<InlineError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces an action error as an alert", () => {
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

  it("shows a saved state error quietly when its panel comes back", async () => {
    const failed = "Pipeline failed: ffmpeg exited 1";
    const { container, rerender } = render(
      <InlineError key="first visit" origin="state" message={failed} />,
    );
    rerender(
      <InlineError key="tab switched back" origin="state" message={failed} />,
    );
    expect(screen.getByText("Pipeline failed: ffmpeg exited 1")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("announces a state error politely when it arrives while the line is mounted", () => {
    const { rerender } = render(<InlineError origin="state" message={null} />);
    rerender(<InlineError origin="state" message="Find hits failed" />);
    expect(screen.getByRole("status")).toHaveTextContent("Find hits failed");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces the next state error after the saved one changes", () => {
    const { rerender } = render(
      <InlineError origin="state" message="Old failure" />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<InlineError origin="state" message={null} />);
    rerender(<InlineError origin="state" message="Old failure" />);
    expect(screen.getByRole("status")).toHaveTextContent("Old failure");
  });
});
