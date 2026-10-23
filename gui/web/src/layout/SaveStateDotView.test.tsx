import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { SaveStateDotView } from "./SaveStateDotView";
import type { SaveState } from "./saveState";

function setup(state: SaveState) {
  const onShowAttention = vi.fn();
  const view = render(
    <SaveStateDotView
      state={state}
      attention={{ kind: "button", activate: onShowAttention }}
    />,
  );
  return { ...view, onShowAttention };
}

describe("SaveStateDotView", () => {
  it.each([
    [{ kind: "saving" }, "Saving to project…"],
    [{ kind: "saved" }, "Saved to project"],
  ] as [SaveState, string][])(
    "shows %j as a read-only light named in full",
    async (state, name) => {
      const { container } = setup(state);
      const dot = screen.getByRole("img", { name });
      expect(dot).toHaveAttribute("data-save-state", state.kind);
      expect(dot).toHaveAttribute("title", name);
      expect(screen.queryByRole("button")).toBeNull();
      await expectNoA11yViolations(container);
    },
  );

  it("marks saving busy and saved not", () => {
    const { rerender, container } = setup({ kind: "saving" });
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    rerender(
      <SaveStateDotView
        state={{ kind: "saved" }}
        attention={{ kind: "button", activate: vi.fn() }}
      />,
    );
    expect(container.firstElementChild).not.toHaveAttribute("aria-busy");
  });

  it("keeps an active failure truthful without an extra activation control", () => {
    const { container } = render(
      <SaveStateDotView
        state={{ kind: "failed", cause: "unreadable" }}
        attention={{ kind: "passive" }}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: "Saved edits could not be read · Retry to read them",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector("button")).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: "waiting", count: 3 }, "Not saved yet · 3 waiting to send"],
    [
      { kind: "failed", cause: "unreadable" },
      "Saved edits could not be read · Retry to read them",
    ],
    [
      {
        kind: "unknown",
        reason: "Undo may have been applied",
        recovery: "inspect-history",
      },
      "Outcome unknown · Undo may have been applied. Inspect History before trying again.",
    ],
  ] as [SaveState, string][])(
    "makes %j a button that goes to Needs attention",
    async (state, name) => {
      const { onShowAttention, container } = setup(state);
      const dot = screen.getByRole("button", { name });
      expect(dot).toHaveAttribute("data-save-state", state.kind);
      expect(dot).toHaveAttribute("title", name);
      await userEvent.click(dot);
      expect(onShowAttention).toHaveBeenCalledTimes(1);
      await expectNoA11yViolations(container);
    },
  );

  it("carries no visible text, so the light stays small", () => {
    const { container } = setup({ kind: "saved" });
    expect(container).toHaveTextContent("");
  });
});
