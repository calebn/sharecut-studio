import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { FindBar, type FindBarHandle, type FindBarProps } from "./FindBar";

function props(over: Partial<FindBarProps> = {}): FindBarProps {
  return {
    query: "room",
    onQueryChange: vi.fn(),
    caseSensitive: false,
    onCaseSensitiveChange: vi.fn(),
    count: 12,
    current: 2,
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    onCutAll: vi.fn(),
    onSelectAll: vi.fn(),
    ...over,
  };
}

const replaceProps = (over = {}) => ({
  open: true,
  onOpenChange: vi.fn(),
  text: "space",
  onTextChange: vi.fn(),
  onReplace: vi.fn(),
  onReplaceAll: vi.fn(),
  ...over,
});

describe("FindBar", () => {
  it("names the bar, takes focus and reads the count", async () => {
    const { container } = render(<FindBar {...props()} />);
    expect(
      screen.getByRole("search", { name: "Find in transcript" }),
    ).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("3 of 12");
    expect(screen.getByRole("button", { name: "Select all 12" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cut all 12" })).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("steps with Enter, Down and Up and the two buttons", async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<FindBar {...handlers} />);
    await user.keyboard("{Enter}{ArrowDown}");
    expect(handlers.onNext).toHaveBeenCalledTimes(2);
    await user.keyboard("{ArrowUp}");
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Next match" }));
    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(handlers.onNext).toHaveBeenCalledTimes(3);
    expect(handlers.onPrevious).toHaveBeenCalledTimes(2);
  });

  it("cuts and selects all hits, and Shift+Enter is Cut all", async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<FindBar {...handlers} />);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(handlers.onCutAll).toHaveBeenCalledTimes(1);
    expect(handlers.onNext).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cut all 12" }));
    await user.click(screen.getByRole("button", { name: "Select all 12" }));
    expect(handlers.onCutAll).toHaveBeenCalledTimes(2);
    expect(handlers.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc from the field, a button and the Replace field", async () => {
    const user = userEvent.setup();
    const handlers = props({ replace: replaceProps() });
    render(<FindBar {...handlers} />);
    await user.keyboard("{Escape}");
    screen.getByRole("button", { name: "Match case" }).focus();
    await user.keyboard("{Escape}");
    screen.getByRole("textbox", { name: "Replace with" }).focus();
    await user.keyboard("{Escape}");
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  it("reports each typed letter and the case toggle", async () => {
    const user = userEvent.setup();
    const handlers = props({ query: "", count: 0, current: -1 });
    render(<FindBar {...handlers} />);
    await user.keyboard("ab");
    expect(vi.mocked(handlers.onQueryChange).mock.calls).toEqual([
      ["a"],
      ["b"],
    ]);
    const aa = screen.getByRole("button", { name: "Match case" });
    expect(aa).toHaveAttribute("aria-pressed", "false");
    await user.click(aa);
    expect(handlers.onCaseSensitiveChange).toHaveBeenCalledWith(true);
  });

  it("says when nothing matches and offers no step or bulk verb", async () => {
    const user = userEvent.setup();
    const handlers = props({ query: "zzz", count: 0, current: -1 });
    render(<FindBar {...handlers} />);
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous match" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Cut all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Select all/ })).toBeNull();
    await user.keyboard("{Enter}{ArrowDown}{Shift>}{Enter}{/Shift}");
    expect(handlers.onNext).not.toHaveBeenCalled();
    expect(handlers.onCutAll).not.toHaveBeenCalled();
  });

  it("draws no Replace for a reader who cannot edit, and no bulk verb the host left out", () => {
    render(
      <FindBar {...props({ onCutAll: undefined, onSelectAll: undefined })} />,
    );
    expect(screen.queryByRole("button", { name: "Show replace" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cut all/ })).toBeNull();
  });

  it("opens the Replace row from its toggle and replaces from the row", async () => {
    const user = userEvent.setup();
    const replace = replaceProps({ open: false });
    const { rerender } = render(<FindBar {...props({ replace })} />);
    const toggle = screen.getByRole("button", { name: "Show replace" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull();
    await user.click(toggle);
    expect(replace.onOpenChange).toHaveBeenCalledWith(true);
    const open = replaceProps();
    rerender(<FindBar {...props({ replace: open })} />);
    expect(screen.getByRole("textbox", { name: "Replace with" })).toHaveValue(
      "space",
    );
    await user.click(screen.getByRole("textbox", { name: "Replace with" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.click(screen.getByRole("button", { name: "Replace all" }));
    expect(open.onReplace).toHaveBeenCalledTimes(2);
    expect(open.onReplaceAll).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor back in the field on the handle's focus", async () => {
    const user = userEvent.setup();
    const handle = createRef<FindBarHandle>();
    render(
      <>
        <FindBar ref={handle} {...props()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    handle.current?.focus();
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveFocus();
  });
});
