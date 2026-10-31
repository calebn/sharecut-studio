import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { TakeSwitcher, type TakeSwitcherProps } from "./TakeSwitcher";

const props = (over: Partial<TakeSwitcherProps> = {}): TakeSwitcherProps => ({
  takes: [
    { takeIndex: 0, length: "8.4 s", words: "22 words", snippet: "First" },
    { takeIndex: 1, length: "9.1 s", words: "1 word", snippet: "Second" },
    { takeIndex: 4, length: "1.2 s", refusal: "Too short." },
  ],
  selected: 1,
  onSelect: vi.fn(),
  ...over,
});
const previous = () => screen.getByRole("button", { name: "Previous take" });
const next = () => screen.getByRole("button", { name: "Next take" });

describe("TakeSwitcher", () => {
  it("says the position among the takes and shows the chosen take's length, words and snippet", () => {
    render(<TakeSwitcher {...props()} />);
    expect(screen.getByRole("group", { name: "Take 2 of 3" })).toBeVisible();
    expect(screen.getByText("9.1 s · 1 word")).toBeVisible();
    expect(screen.getByText("“Second”")).toBeVisible();
  });

  it("sends the neighbouring take_index, not its position", async () => {
    const onSelect = vi.fn();
    render(<TakeSwitcher {...props({ onSelect, selected: 0 })} />);
    await userEvent.click(next());
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("disables a neighbour that Accept would refuse, with the reason", async () => {
    const onSelect = vi.fn();
    render(<TakeSwitcher {...props({ onSelect })} />);
    expect(next()).toBeDisabled();
    expect(next()).toHaveAttribute(
      "title",
      "Take 3 cannot be placed: Too short.",
    );
    await userEvent.click(next());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables Previous on the first take and Next on the last", () => {
    const { rerender } = render(<TakeSwitcher {...props({ selected: 0 })} />);
    expect(previous()).toBeDisabled();
    expect(previous()).toHaveAttribute("title", "This is the first take.");
    rerender(
      <TakeSwitcher
        {...props({
          selected: 4,
          takes: props().takes.map((t) => ({ ...t, refusal: undefined })),
        })}
      />,
    );
    expect(next()).toHaveAttribute("title", "This is the last take.");
  });

  it("explains a chosen take that Accept would refuse", () => {
    render(<TakeSwitcher {...props({ selected: 4 })} />);
    expect(
      screen.getByText("Replace is not available for this take: Too short."),
    ).toBeVisible();
  });

  it("moves with the arrow keys only while focus is in the group, and keeps them from the page", () => {
    const onSelect = vi.fn();
    const outside = vi.fn();
    render(
      <div role="presentation" onKeyDown={outside}>
        <TakeSwitcher {...props({ onSelect })} />
      </div>,
    );
    fireEvent.keyDown(previous(), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(previous(), { key: "ArrowUp" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(next(), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(outside).not.toHaveBeenCalled();
    fireEvent.keyDown(next(), { key: "x" });
    expect(outside).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the other button when the one pressed goes disabled", async () => {
    const { rerender } = render(<TakeSwitcher {...props()} />);
    previous().focus();
    await userEvent.keyboard("{Enter}");
    rerender(<TakeSwitcher {...props({ selected: 0 })} />);
    expect(next()).toHaveFocus();
  });

  it("does not take focus when the choice is refused and a later change arrives", async () => {
    const onSelect = vi.fn(async () => false);
    const { rerender } = render(<TakeSwitcher {...props({ onSelect })} />);
    previous().focus();
    await userEvent.keyboard("{Enter}");
    await Promise.resolve();
    rerender(<TakeSwitcher {...props({ onSelect, selected: 0 })} />);
    expect(next()).not.toHaveFocus();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<TakeSwitcher {...props()} />);
    await expectNoA11yViolations(container);
  });
});
