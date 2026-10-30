import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { BUSY_REASON } from "../../ui/disabledReason";
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
  onReplaceAll: vi.fn(() => 3),
  ...over,
});

describe("FindBar", () => {
  it("names the bar, takes focus and reads the count", async () => {
    const { container } = render(<FindBar {...props()} />);
    expect(
      screen.getByRole("search", { name: "Find in transcript" }),
    ).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveFocus();
    expect(screen.getByText("3 of 12")).toBeVisible();
    expect(
      screen.getByRole("searchbox", { name: "Find" }),
    ).toHaveAccessibleDescription("3 of 12");
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

  it("steps back on Shift+Enter and cuts all hits on Mod+Shift+Enter or its own button", async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(<FindBar {...handlers} />);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    expect(handlers.onCutAll).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await user.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
    expect(handlers.onCutAll).toHaveBeenCalledTimes(2);
    expect(handlers.onNext).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(handlers.onNext).not.toHaveBeenCalled();
    const cut = screen.getByRole("button", { name: "Cut all 12" });
    expect(cut).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+Enter Meta+Shift+Enter",
    );
    await user.click(cut);
    await user.click(screen.getByRole("button", { name: "Select all 12" }));
    expect(handlers.onCutAll).toHaveBeenCalledTimes(3);
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
    expect(screen.getByText("No matches")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous match" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Cut all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Select all/ })).toBeNull();
    await user.keyboard(
      "{Enter}{ArrowDown}{Shift>}{Enter}{/Shift}{Control>}{Shift>}{Enter}{/Shift}{/Control}",
    );
    expect(handlers.onNext).not.toHaveBeenCalled();
    expect(handlers.onPrevious).not.toHaveBeenCalled();
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

  it("draws no Replace button when the host has no single replace", async () => {
    const user = userEvent.setup();
    const replace = replaceProps({ onReplace: undefined });
    render(<FindBar {...props({ replace })} />);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    await user.click(screen.getByRole("textbox", { name: "Replace with" }));
    await user.keyboard("{Enter}");
    expect(replace.onReplaceAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Replace all" }));
    expect(replace.onReplaceAll).toHaveBeenCalledTimes(1);
  });

  it("reads a count with no current hit as a total, not 0 of N", () => {
    render(<FindBar {...props({ current: -1 })} />);
    expect(screen.getByText("12 matches")).toBeVisible();
    expect(screen.queryByText(/^0 of/)).toBeNull();
  });

  it("draws no live region of its own, because the pane has the one", () => {
    render(<FindBar {...props({ replace: replaceProps() })} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("points aria-controls at the Replace row only while it exists", () => {
    const { rerender } = render(
      <FindBar {...props({ replace: replaceProps({ open: false }) })} />,
    );
    const toggle = screen.getByRole("button", { name: "Show replace" });
    expect(toggle).not.toHaveAttribute("aria-controls");
    rerender(<FindBar {...props({ replace: replaceProps() })} />);
    const id = toggle.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")).toContainElement(
      screen.getByRole("textbox", { name: "Replace with" }),
    );
  });

  it("holds Replace and All until the replacement has a letter or a number, and says so", async () => {
    const user = userEvent.setup();
    const blank = replaceProps({ text: "" });
    const { rerender } = render(<FindBar {...props({ replace: blank })} />);
    for (const name of ["Replace", "Replace all"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        "Enter replacement text with a letter or a number to replace.",
      );
      await user.click(button);
      button.focus();
      expect(button).toHaveFocus();
    }
    expect(
      screen.getByText(
        "Enter replacement text with a letter or a number to replace.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("textbox", { name: "Replace with" }));
    await user.keyboard("{Enter}");
    expect(blank.onReplace).not.toHaveBeenCalled();
    expect(blank.onReplaceAll).not.toHaveBeenCalled();
    rerender(
      <FindBar {...props({ replace: replaceProps({ text: "..." }) })} />,
    );
    expect(screen.getByRole("button", { name: "Replace" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    rerender(<FindBar {...props({ replace: replaceProps({ text: "x" }) })} />);
    const ready = screen.getByRole("button", { name: "Replace" });
    expect(ready).not.toHaveAttribute("aria-disabled");
    expect(ready).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/Enter replacement text/)).toBeNull();
  });

  it("says there is nothing to replace when the search has no hits", async () => {
    const user = userEvent.setup();
    const replace = replaceProps();
    const { container } = render(
      <FindBar {...props({ count: 0, current: 0, replace })} />,
    );
    const note = screen.getByText(
      "No matches to replace. Change the search first.",
    );
    expect(note).toBeVisible();
    for (const name of ["Replace", "Replace all"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("aria-describedby", note.id);
      await user.click(button);
    }
    expect(replace.onReplace).not.toHaveBeenCalled();
    expect(replace.onReplaceAll).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("limits the fields to maxLength, 500 by default", () => {
    const { rerender } = render(
      <FindBar {...props({ replace: replaceProps() })} />,
    );
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveAttribute(
      "maxlength",
      "500",
    );
    rerender(
      <FindBar {...props({ replace: replaceProps(), maxLength: 40 })} />,
    );
    expect(
      screen.getByRole("textbox", { name: "Replace with" }),
    ).toHaveAttribute("maxlength", "40");
  });

  it("holds every verb and the fields while busy and shows the host's error", async () => {
    const user = userEvent.setup();
    const handlers = props({
      busy: true,
      error: "The transcript changed. Search again.",
      replace: replaceProps(),
    });
    render(<FindBar {...handlers} />);
    expect(screen.getByRole("button", { name: "Cut all 12" })).toBeDisabled();
    for (const name of ["Replace", "Replace all"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(BUSY_REASON);
    }
    await user.click(screen.getByRole("button", { name: "Replace all" }));
    expect(handlers.replace?.onReplaceAll).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox", { name: "Find" })).toHaveAttribute(
      "readonly",
    );
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(handlers.onCutAll).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The transcript changed. Search again.",
    );
  });

  it("fires a bulk verb once while it is pending, reports a rejection, and hands focus on when it settles", async () => {
    const user = userEvent.setup();
    let finish: (count: number) => void = () => undefined;
    const returnFocus = vi.fn();
    const replace = replaceProps({
      onReplaceAll: vi.fn(
        () => new Promise<number>((resolve) => (finish = resolve)),
      ),
    });
    render(<FindBar {...props({ replace, returnFocus })} />);
    const all = screen.getByRole("button", { name: "Replace all" });
    await user.click(all);
    await user.click(all);
    expect(replace.onReplaceAll).toHaveBeenCalledTimes(1);
    expect(all).toHaveAttribute("aria-disabled", "true");
    expect(all).toHaveAccessibleDescription(BUSY_REASON);
    expect(returnFocus).not.toHaveBeenCalled();
    await act(async () => finish(12));
    expect(returnFocus).toHaveBeenCalledTimes(1);
    expect(all).not.toHaveAttribute("aria-disabled");
  });

  it("shows a rejected request's message and keeps the bar open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCutAll = vi.fn().mockRejectedValue(new Error("Offline."));
    render(<FindBar {...props({ onCutAll, onClose })} />);
    await user.click(screen.getByRole("button", { name: "Cut all 12" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts focus in the Find field when a bulk verb leaves nothing to press and the host gave no target", async () => {
    const user = userEvent.setup();
    function Host() {
      const [count, setCount] = useState(2);
      return (
        <FindBar
          {...props({ count, current: count ? 0 : -1 })}
          onCutAll={() => setCount(0)}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "Cut all 2" }));
    expect(screen.queryByRole("button", { name: /^Cut all/ })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Find" })).toHaveFocus(),
    );
  });

  it("returns focus to the host's target on Esc and on Close, after closing", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const handlers = props({
      onClose: vi.fn(() => order.push("close")),
      returnFocus: vi.fn(() => order.push("focus")),
    });
    render(<FindBar {...handlers} />);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close find" }));
    expect(order).toEqual(["close", "focus", "close", "focus"]);
  });

  it("keeps focus in the Find field while typing after a bulk verb, though the host passes a new returnFocus on every render", async () => {
    const user = userEvent.setup();
    const target = document.createElement("button");
    document.body.append(target);
    const returned = vi.fn(() => target.focus());
    function Host() {
      const [query, setQuery] = useState("the");
      return (
        <FindBar
          {...props({ query, count: query ? 4 : 0, current: query ? 0 : -1 })}
          onQueryChange={setQuery}
          onCutAll={() => setQuery("")}
          returnFocus={() => returned()}
        />
      );
    }
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "Cut all 4" }));
    await waitFor(() => expect(target).toHaveFocus());
    expect(returned).toHaveBeenCalledTimes(1);
    const field = screen.getByRole("searchbox", { name: "Find" });
    await user.click(field);
    await user.keyboard("room");
    expect(field).toHaveValue("room");
    expect(field).toHaveFocus();
    expect(returned).toHaveBeenCalledTimes(1);
    target.remove();
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
