import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { AskDialog } from "./AskDialog";
import { askConfirm } from "./ask";

const REMOVE = {
  title: "Remove the Host track?",
  message: "Its clips leave the timeline.",
  keepLabel: "Keep track",
  actionLabel: "Remove track",
  danger: true,
};

describe("AskDialog", () => {
  it("asks in a labelled dialog with Keep focused first and the danger action last", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<AskDialog />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = askConfirm(REMOVE);
    });
    const dialog = screen.getByRole("dialog", {
      name: "Remove the Host track?",
      description: "Its clips leave the timeline.",
    });
    expect(dialog).toHaveAccessibleDescription("Its clips leave the timeline.");
    const keep = screen.getByRole("button", { name: "Keep track" });
    const remove = screen.getByRole("button", { name: "Remove track" });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(remove).toHaveClass("danger");
    expect(
      keep.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expectNoA11yViolations(baseElement);
    await user.click(remove);
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps on Escape", async () => {
    const user = userEvent.setup();
    render(<AskDialog />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = askConfirm({ ...REMOVE, danger: false });
    });
    expect(screen.getByRole("button", { name: "Remove track" })).toHaveClass(
      "primary",
    );
    await user.keyboard("{Escape}");
    await expect(answer).resolves.toBe(false);
  });
});
