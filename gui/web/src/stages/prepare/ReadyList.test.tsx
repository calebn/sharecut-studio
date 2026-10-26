import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ROWS } from "./prepareFixture";
import { ReadyList } from "./ReadyList";

describe("ReadyList", () => {
  it("lists the five rows in a named list", () => {
    render(<ReadyList rows={ROWS.queued} onAction={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Getting ready" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  });

  it("opens a row that needs you and keeps it in the pipeline order", () => {
    render(<ReadyList rows={ROWS.alignCheck} onAction={vi.fn()} />);
    const items = screen.getAllByRole("listitem");
    expect(items[2]).toHaveTextContent("Line up tracks");
    expect(
      within(items[2]).getByRole("button", { name: /Line up tracks/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(items[2]).toHaveTextContent("Needs you: Line up tracks");
  });

  it("does not reorder the DOM when a different row needs you", () => {
    const { rerender } = render(
      <ReadyList rows={ROWS.failed} onAction={vi.fn()} />,
    );
    const before = screen.getAllByRole("listitem");
    rerender(<ReadyList rows={ROWS.alignCheck} onAction={vi.fn()} />);
    const after = screen.getAllByRole("listitem");
    expect(after).toHaveLength(before.length);
    for (const [at, item] of after.entries()) expect(item).toBe(before[at]);
    expect(
      after.map((item) => item.querySelector(".sys-status-title")?.textContent),
    ).toEqual([
      "Add audio",
      "Transcribe",
      "Line up tracks",
      "Clean and level",
      "Find suggestions",
    ]);
  });

  it("keeps the extra buttons in a labelled group in the body", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ReadyList rows={ROWS.alignCheck} onAction={onAction} />);
    const group = screen.getByRole("group", { name: /Listen to the move/ });
    const names = within(group)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Hear it", "Looks right", "Undo move"]);
    await user.click(within(group).getByRole("button", { name: "Undo move" }));
    expect(onAction).toHaveBeenCalledWith("align", "undo-move");
  });

  it("makes Keep my fixes the default look and Replace the outlined danger button", () => {
    render(<ReadyList rows={ROWS.keepFixes} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Keep my fixes" })).toHaveClass(
      "primary",
    );
    const replace = screen.getByRole("button", { name: "Replace" });
    expect(replace).toHaveClass("danger", "sys-danger-outline");
    expect(replace).not.toHaveClass("primary");
  });

  it("puts focus on Keep my fixes, never Replace, when the row is opened by hand", async () => {
    const user = userEvent.setup();
    render(<ReadyList rows={ROWS.keepFixes} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Replace" })).not.toHaveFocus();
    const row = screen.getByRole("button", { name: /Transcribe/ });
    await user.click(row);
    await user.click(row);
    expect(screen.getByRole("button", { name: "Keep my fixes" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Replace" })).not.toHaveFocus();
  });

  it("never moves focus when a row appears, opens or changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReadyList rows={ROWS.running} onAction={vi.fn()} />,
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    rerender(<ReadyList rows={ROWS.keepFixes} onAction={vi.fn()} />);
    expect(outside).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Keep my fixes" }),
    ).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: /Transcribe/ }));
    outside.remove();
  });

  it("shows the plain cause, Try again, and the technical cause behind Details", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ReadyList rows={ROWS.failed} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAction).toHaveBeenCalledWith("transcribe", "try-again");
    const item = screen.getAllByRole("listitem")[1];
    expect(item).toHaveTextContent("Failed: Transcribe");
    expect(item).toHaveTextContent("Not enough memory to finish");
    expect(item.querySelector("[data-state='failed']")).not.toBeNull();
    const details = screen.getByRole("button", {
      name: "Details for Transcribe",
    });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/ran out of memory/)).toBeNull();
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/ran out of memory/)).toBeVisible();
  });

  it("gives every running row a progress bar with words", () => {
    render(<ReadyList rows={ROWS.alignCheck} onAction={vi.fn()} />);
    const bar = screen.getByRole("progressbar", { name: "Clean and level" });
    expect(bar).toHaveAttribute("aria-valuetext", "30 percent");
  });

  it("says what to do in the model and word-timing rows", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { rerender } = render(
      <ReadyList rows={ROWS.needsModel} onAction={onAction} />,
    );
    await user.click(screen.getByRole("button", { name: "Download 1.6 GB" }));
    expect(onAction).toHaveBeenCalledWith("transcribe", "download-model");
    rerender(<ReadyList rows={ROWS.approximateTiming} onAction={onAction} />);
    expect(screen.getByText(/Word timing is approximate/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Download word timing (360 MB)" }),
    );
    expect(onAction).toHaveBeenCalledWith("transcribe", "download-aligner");
  });

  it("reads the running bar in words", () => {
    render(<ReadyList rows={ROWS.running} onAction={vi.fn()} />);
    expect(
      screen.getByRole("progressbar", { name: "Transcribe" }),
    ).toHaveAttribute("aria-valuetext", "2 of 3 speakers · about 1 min left");
  });
});
