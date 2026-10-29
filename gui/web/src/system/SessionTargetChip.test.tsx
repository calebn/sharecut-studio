import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionTargetChip } from "./SessionTargetChip";

describe("SessionTargetChip", () => {
  it("opens a menu before the first take and picks a target", async () => {
    const onTarget = vi.fn();
    render(<SessionTargetChip target="start" onTarget={onTarget} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Where this session goes: Starts the episode",
      }),
    );
    expect(
      screen.getByRole("menu", { name: "Where this session goes" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "At the end" }));
    expect(onTarget).toHaveBeenCalledWith("end");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("names the trigger by its subject and contains its visible text", () => {
    render(<SessionTargetChip target="end" />);
    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent("At the end");
    expect(trigger).toHaveAccessibleName("Where this session goes: At the end");
  });

  it("offers both choices", async () => {
    render(<SessionTargetChip target="end" />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Where this session goes: At the end",
      }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Starts the episode", "At the end"]);
  });

  it("locks to text with the reason, and is not a tab stop", async () => {
    render(<SessionTargetChip target="start" locked />);
    expect(screen.getByText("Set when the first take landed")).toBeVisible();
    expect(screen.getByText("Starts the episode")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    const chip = screen.getByRole("group", { name: "Where this session goes" });
    expect(chip).toHaveAccessibleDescription("Set when the first take landed");
    await userEvent.tab();
    expect(document.body).toHaveFocus();
  });

  describe("with a view target", () => {
    const open = async (name: string) =>
      userEvent.click(screen.getByRole("button", { name }));
    const items = () =>
      screen.getAllByRole("menuitem").map((item) => item.textContent);

    it("words the trigger and offers only end and start without Edit state", async () => {
      render(<SessionTargetChip target={{ kind: "end", afterSec: 3130 }} />);
      await open("Where this session goes: Lands at the end · after 52:10");
      expect(items()).toEqual(["At the end", "At the start"]);
    });

    it("offers the playhead and the selection when Edit has them", async () => {
      const onChange = vi.fn();
      render(
        <SessionTargetChip
          target={{ kind: "insert", atSec: 724 }}
          playheadSec={724}
          selection={{ fromSec: 724, toSec: 749 }}
          endAfterSec={3130}
          onChange={onChange}
        />,
      );
      await open("Where this session goes: Inserts at 12:04");
      expect(items()).toEqual([
        "At the end",
        "At the start",
        "At the playhead (12:04)",
        "Replace selection",
      ]);
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Replace selection" }),
      );
      expect(onChange).toHaveBeenCalledWith({
        kind: "replace",
        fromSec: 724,
        toSec: 749,
      });
    });

    it("picks the end with where it lands", async () => {
      const onChange = vi.fn();
      render(
        <SessionTargetChip
          target={{ kind: "start" }}
          endAfterSec={3130}
          onChange={onChange}
        />,
      );
      await open("Where this session goes: Starts the episode");
      await userEvent.click(
        screen.getByRole("menuitem", { name: "At the end" }),
      );
      expect(onChange).toHaveBeenCalledWith({ kind: "end", afterSec: 3130 });
    });

    it("locks with the wording of the target", () => {
      render(
        <SessionTargetChip
          target={{ kind: "replace", fromSec: 724, toSec: 749 }}
          locked
        />,
      );
      expect(screen.getByText("Replaces 12:04-12:29")).toBeVisible();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  it("marks the trigger unavailable with its reason", () => {
    render(
      <SessionTargetChip
        target="end"
        disabledReason="Waiting for the last change"
      />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
