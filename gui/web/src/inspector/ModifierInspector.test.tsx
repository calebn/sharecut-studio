import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { ModifierInspector } from "./ModifierInspector";

describe("ModifierInspector", () => {
  it("renders badge, title, subtitle, body, and footer", () => {
    render(
      <ModifierInspector
        badge="Clip"
        title="Clip"
        subtitle="clip-1"
        footer={<span>Footer bit</span>}
      >
        <p>Body content</p>
      </ModifierInspector>,
    );
    expect(
      screen.getByText("Clip", { selector: ".modifier-badge" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clip" })).toBeInTheDocument();
    expect(screen.getByText("clip-1")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
    expect(screen.getByText("Footer bit")).toBeInTheDocument();
  });

  it("fires primary actions and shows errors", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <ModifierInspector
        badge="Pending"
        title="Pending edit"
        primaryActions={[
          { label: "Approve", variant: "primary", onClick: onApprove },
          { label: "Reject", variant: "danger", onClick: onReject },
        ]}
        error="Something failed"
        footer={<span>Footer bit</span>}
      >
        <p>Body content</p>
      </ModifierInspector>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something failed");
    expect(container.querySelector(".modifier-body")).toBeInstanceOf(
      HTMLElement,
    );
    expect(container.querySelector(".modifier-error")).toBeInstanceOf(
      HTMLElement,
    );
    expect(container.querySelector(".modifier-footer")).toBeInstanceOf(
      HTMLElement,
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("is axe-clean with actions and error", async () => {
    const { container } = render(
      <ModifierInspector
        badge="Clip"
        title="Clip"
        subtitle="id"
        primaryActions={[
          { label: "Apply", variant: "primary", onClick: () => {} },
        ]}
        error="Fade times must be non-negative"
        footer={<button type="button">Seek</button>}
      >
        <dl>
          <dt>ID</dt>
          <dd>clip-1</dd>
        </dl>
      </ModifierInspector>,
    );
    await expectNoA11yViolations(container);
  });
});
