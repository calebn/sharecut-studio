import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionTargetChip } from "./SessionTargetChip";

describe("SessionTargetChip", () => {
  it("opens a menu before the first take and picks a target", async () => {
    const onTarget = vi.fn();
    render(<SessionTargetChip target="start" onTarget={onTarget} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Starts the episode" }),
    );
    expect(
      screen.getByRole("menu", { name: "Where this session goes" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "At the end" }));
    expect(onTarget).toHaveBeenCalledWith("end");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("offers both choices", async () => {
    render(<SessionTargetChip target="end" />);
    await userEvent.click(screen.getByRole("button", { name: "At the end" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Starts the episode", "At the end"]);
  });

  it("locks to text with the reason, and is not a tab stop", async () => {
    render(<SessionTargetChip target="start" locked />);
    expect(screen.getByText("Set when the first take landed")).toBeVisible();
    expect(screen.getByText("Starts the episode")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    await userEvent.tab();
    expect(document.body).toHaveFocus();
  });
});
