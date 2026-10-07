import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Dialog } from "./Dialog";
import { InlineConfirm } from "./InlineConfirm";

const PROMPT = "Remove this track? Its clips leave the timeline.";

function renderConfirm(disabled = false) {
  const onKeep = vi.fn();
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <Dialog open onClose={onClose} title="Track">
      <InlineConfirm
        prompt={PROMPT}
        keepLabel="Keep track"
        actionLabel="Remove track"
        disabled={disabled}
        onKeep={onKeep}
        onConfirm={onConfirm}
      />
    </Dialog>,
  );
  return { ...view, onKeep, onConfirm, onClose };
}

describe("InlineConfirm", () => {
  it("names the consequence, puts Keep first and focuses it; axe-clean", async () => {
    const { baseElement } = renderConfirm();
    const group = screen.getByRole("group", { name: PROMPT });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => [b.textContent, b.className.includes("danger")]),
    ).toEqual([
      ["Keep track", false],
      ["Remove track", true],
    ]);
    expect(
      within(group).getByRole("button", { name: "Keep track" }),
    ).toHaveFocus();
    await expectNoA11yViolations(baseElement);
  });

  it("reports Keep and the action through their callbacks", async () => {
    const user = userEvent.setup();
    const { onKeep, onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: "Remove track" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Keep track" }));
    expect(onKeep).toHaveBeenCalledOnce();
  });

  it("disables both choices while the owner is busy", () => {
    renderConfirm(true);
    for (const button of within(
      screen.getByRole("group", { name: PROMPT }),
    ).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});
