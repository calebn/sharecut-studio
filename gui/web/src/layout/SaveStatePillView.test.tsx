import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { SaveStatePillView } from "./SaveStatePillView";
import type { SaveState } from "./saveState";

function setup(state: SaveState) {
  const handlers = {
    onSendNow: vi.fn(),
    onSeeWhy: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<SaveStatePillView state={state} {...handlers} />);
  return { ...view, ...handlers };
}

describe("SaveStatePillView", () => {
  it.each([
    [{ kind: "saving" }, "Saving to project…"],
    [{ kind: "saved" }, "Saved to project"],
  ] as [SaveState, string][])(
    "shows %j as a read-only line",
    async (state, text) => {
      const { container } = setup(state);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
      expect(
        container.querySelector(`[data-save-state="${state.kind}"]`),
      ).not.toBeNull();
      await expectNoA11yViolations(container);
    },
  );

  it("marks saving busy and saved not", () => {
    const { rerender, container } = setup({ kind: "saving" });
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    rerender(
      <SaveStatePillView
        state={{ kind: "saved" }}
        onSendNow={vi.fn()}
        onSeeWhy={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.firstElementChild).not.toHaveAttribute("aria-busy");
  });

  it("offers Send now on waiting edits, and says they stay on this device", async () => {
    const { onSendNow, onSeeWhy, onRetry, container } = setup({
      kind: "waiting",
      count: 3,
    });
    const button = screen.getByRole("button", {
      name: "Not saved yet · 3 waiting to send",
    });
    expect(button).toHaveAttribute(
      "title",
      "Kept on this device until it sends. Press to send now.",
    );
    await userEvent.click(button);
    expect(onSendNow).toHaveBeenCalledTimes(1);
    expect(onSeeWhy).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("names the refusal and takes the host to it", async () => {
    const { onSeeWhy, container } = setup({
      kind: "failed",
      cause: "refused",
      reason: "The clip moved",
    });
    const button = screen.getByRole("button", {
      name: "Save failed · See why",
    });
    expect(button).toHaveAttribute("title", "The clip moved");
    await userEvent.click(button);
    expect(onSeeWhy).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("retries reading unreadable saved edits", async () => {
    const { onRetry } = setup({ kind: "failed", cause: "unreadable" });
    await userEvent.click(
      screen.getByRole("button", { name: "Save failed · Retry" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
