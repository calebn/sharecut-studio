import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { AskDialog } from "./AskDialog";
import { askConfirm, askText } from "./ask";

const REMOVE = {
  title: "Remove the Host track?",
  message: "Its clips leave the timeline.",
  keepLabel: "Keep track",
  actionLabel: "Remove track",
  danger: true,
};

const OPEN = {
  title: "Open project",
  label: "Path to episode.project.json",
  hint: "The file picker is not available here.",
  submitLabel: "Open project",
  requiredMessage: "Enter the path to an episode.project.json file.",
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
    });
    expect(dialog).toHaveTextContent("Its clips leave the timeline.");
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

  it("wires an empty path's error to the field, then returns the typed path", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<AskDialog />);
    let answer!: Promise<string | null>;
    act(() => {
      answer = askText(OPEN);
    });
    const input = screen.getByRole("textbox", {
      name: "Path to episode.project.json",
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAccessibleDescription(
      "The file picker is not available here.",
    );
    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "The file picker is not available here. Enter the path to an episode.project.json file.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the path to an episode.project.json file.",
    );
    await expectNoA11yViolations(baseElement);
    await user.type(input, "/tmp/ep/episode.project.json{Enter}");
    await expect(answer).resolves.toBe("/tmp/ep/episode.project.json");
  });

  it("returns null on Cancel", async () => {
    const user = userEvent.setup();
    render(<AskDialog />);
    let answer!: Promise<string | null>;
    act(() => {
      answer = askText(OPEN);
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
  });
});
