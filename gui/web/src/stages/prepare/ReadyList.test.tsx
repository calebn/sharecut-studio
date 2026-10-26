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

  it("puts a row that needs you first and opens it", () => {
    render(<ReadyList rows={ROWS.alignCheck} onAction={vi.fn()} />);
    const first = screen.getAllByRole("listitem")[0];
    expect(first).toHaveTextContent("Line up tracks");
    expect(
      within(first).getByRole("button", { name: /Line up tracks/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveTextContent("Needs you");
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
    expect(replace).toHaveClass("danger");
    expect(replace).not.toHaveClass("primary");
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

  it("has one action in a failed row and its details behind the row button", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ReadyList rows={ROWS.failed} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAction).toHaveBeenCalledWith("transcribe", "try-again");
    const row = screen.getByRole("button", { name: /Transcribe/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/ran out of memory/)).toBeNull();
    await user.click(row);
    expect(screen.getByText(/ran out of memory/)).toBeVisible();
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("Failed");
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
