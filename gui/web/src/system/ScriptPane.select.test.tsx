import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptPane, type ScriptPaneProps } from "./ScriptPane";
import {
  cutMark,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";

function props(over: Partial<ScriptPaneProps> = {}): ScriptPaneProps {
  return {
    turns: SCRIPT_TURNS,
    onCaret: vi.fn(),
    onSelect: vi.fn(),
    onSeek: vi.fn(),
    onPrimary: vi.fn(),
    onClearSelection: vi.fn(),
    onSeamSelect: vi.fn(),
    onSuggestionSelect: vi.fn(),
    ...over,
  };
}

const word = (name: string) => screen.getByRole("button", { name });
const words = (anchor: number, head: number) => ({
  kind: "words" as const,
  anchor,
  head,
});

/** Five places to a line, 60 px apart, lines 26 px apart: jsdom has no layout. */
function layoutInGrid() {
  const rectOf = (el: HTMLElement) => {
    const at = Number(el.dataset.stop);
    if (Number.isNaN(at)) return new DOMRect(0, 0, 0, 0);
    return new DOMRect((at % 5) * 60, Math.floor(at / 5) * 26, 50, 20);
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return rectOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return [rectOf(this)] as unknown as DOMRectList;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScriptPane up and down", () => {
  it("moves the caret to the place on the next line under the same column", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const onCaret = vi.fn();
    render(<ScriptPane {...props({ onCaret })} />);
    word("sound").focus();
    await user.keyboard("{ArrowDown}");
    expect(word("Thanks")).toHaveFocus();
    expect(onCaret.mock.calls).toEqual([[20]]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(word("how")).toHaveFocus();
    expect(onCaret.mock.calls).toEqual([[20], [15], [10]]);
  });

  it("walks down a column and starts again from the new column after a sideways move", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const onCaret = vi.fn();
    render(<ScriptPane {...props({ onCaret })} />);
    word("Welcome").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(onCaret.mock.calls.slice(-2)).toEqual([[9], [14]]);
    await user.keyboard("{ArrowLeft}{ArrowDown}");
    expect(onCaret.mock.calls.slice(-2)).toEqual([[13], [18]]);
  });

  it("extends the selection a line at a time with Shift", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect })} />);
    word("Today").focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(onSelect.mock.calls).toEqual([[words(5, 10)]]);
  });

  it("does nothing on the first or the last line", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const onCaret = vi.fn();
    render(<ScriptPane {...props({ onCaret })} />);
    word("Welcome").focus();
    await user.keyboard("{ArrowUp}");
    word("first?").focus();
    await user.keyboard("{ArrowDown}");
    expect(onCaret).not.toHaveBeenCalled();
    expect(word("first?")).toHaveFocus();
  });
});

describe("ScriptPane Alt+Shift", () => {
  it("shrinks the selection from its start with Right and grows it with Left", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect, selection: words(12, 14) })} />);
    word("small (selected)").focus();
    await user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    expect(onSelect.mock.calls).toEqual([[words(13, 14)], [words(11, 14)]]);
  });

  it("keeps the browser from going back and does nothing without a selection", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ScriptPane {...props({ onSelect, selection: words(12, 14) })} />,
    );
    const target = word("small (selected)");
    expect(
      fireEvent.keyDown(target, {
        key: "ArrowLeft",
        altKey: true,
        shiftKey: true,
      }),
    ).toBe(false);
    onSelect.mockClear();
    rerender(<ScriptPane {...props({ onSelect })} />);
    fireEvent.keyDown(word("small"), {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ScriptPane Esc", () => {
  it("clears a selection of words, a cut or a suggestion", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 3, { mark: cutMark("c1", 0.7) }),
      ...spanPatch(6, 7, { mark: suggestedMark("s1") }),
    });
    const { rerender } = render(
      <ScriptPane
        {...props({ onClearSelection, turns, selection: words(12, 14) })}
      />,
    );
    word("small (selected)").focus();
    await user.keyboard("{Escape}");
    rerender(
      <ScriptPane
        {...props({
          onClearSelection,
          turns,
          selection: { kind: "cut", id: "c1" },
        })}
      />,
    );
    word("Cut, 0.7 s removed").focus();
    await user.keyboard("{Escape}");
    rerender(
      <ScriptPane
        {...props({
          onClearSelection,
          turns,
          selection: { kind: "suggestion", id: "s1" },
        })}
      />,
    );
    word("Suggested cut: we are").focus();
    await user.keyboard("{Escape}");
    expect(onClearSelection).toHaveBeenCalledTimes(3);
  });

  it("is left to the page when nothing is selected", () => {
    const onClearSelection = vi.fn();
    render(<ScriptPane {...props({ onClearSelection })} />);
    expect(fireEvent.keyDown(word("small"), { key: "Escape" })).toBe(true);
    expect(onClearSelection).not.toHaveBeenCalled();
  });
});

describe("ScriptPane speaker and time by keyboard", () => {
  const margin = () => props({ onSpeaker: vi.fn(), onSeekTurn: vi.fn() });

  it("enters the margin with Left from a turn's first word and walks it with Up and Down", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...margin()} />);
    word("Thanks").focus();
    await user.keyboard("{ArrowLeft}");
    expect(word("Anneke de Vries, change speaker")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(word("Play from 12:19")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(word("Play from 12:19")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(word("Anneke de Vries, change speaker")).toHaveFocus();
  });

  it("returns to the words with Right and to the turn before with Left", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...margin()} />);
    word("Thanks").focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(word("Thanks")).toHaveFocus();
    expect(word("Thanks")).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(word("one.")).toHaveFocus();
  });

  it("presses with Enter and leaves Space to Play/Pause", async () => {
    const user = userEvent.setup();
    const handlers = margin();
    render(<ScriptPane {...handlers} />);
    word("Thanks").focus();
    await user.keyboard("{ArrowLeft} ");
    expect(handlers.onSpeaker).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(handlers.onSpeaker).toHaveBeenCalledWith(
      "t2",
      screen.getByRole("button", { name: "Anneke de Vries, change speaker" }),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(handlers.onSeekTurn).toHaveBeenCalledWith("t2");
  });

  it("walks past a turn that repeats the speaker, which has no margin", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...margin()} />);
    word("That").focus();
    await user.keyboard("{ArrowLeft}");
    expect(word("microphones.")).toHaveFocus();
  });

  it("reaches only the time when the host offers no speaker popover", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...props({ onSeekTurn: vi.fn() })} />);
    word("Thanks").focus();
    await user.keyboard("{ArrowLeft}");
    expect(word("Play from 12:19")).toHaveFocus();
  });

  it("keeps the margin out of the tab order", () => {
    const { container } = render(<ScriptPane {...margin()} />);
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>(".sys-script-body *"),
    ].filter((el) => el.tabIndex >= 0);
    expect(tabbable.map((el) => el.textContent)).toEqual(["Welcome"]);
  });
});

describe("ScriptPane marks across turns", () => {
  it("presses every pill of a cut that crosses a turn boundary", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(18, 21, { mark: cutMark("x", 1.5) }),
    });
    render(
      <ScriptPane {...props({ turns, selection: { kind: "cut", id: "x" } })} />,
    );
    expect(
      screen
        .getAllByRole("button", { name: "Cut, 1.5 s removed" })
        .map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "true"]);
  });

  it("keeps a cut and a suggestion with the same id apart", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 3, { mark: cutMark("a", 0.7) }),
      ...spanPatch(41, 42, { mark: suggestedMark("a") }),
    });
    const { rerender } = render(
      <ScriptPane {...props({ turns, selection: { kind: "cut", id: "a" } })} />,
    );
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "true");
    expect(word("Suggested cut: changed everything")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    rerender(
      <ScriptPane
        {...props({ turns, selection: { kind: "suggestion", id: "a" } })}
      />,
    );
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "false");
    expect(word("Suggested cut: changed everything")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("tints a pill inside a words selection without pressing it", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 3, { mark: cutMark("c1", 0.7) }),
    });
    const { container, rerender } = render(
      <ScriptPane {...props({ turns, selection: words(0, 6) })} />,
    );
    const pill = () => container.querySelector(".sys-script-pill");
    expect(pill()).toHaveAttribute("data-in-selection", "");
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "false");
    rerender(<ScriptPane {...props({ turns, selection: words(5, 8) })} />);
    expect(pill()).not.toHaveAttribute("data-in-selection");
    rerender(
      <ScriptPane
        {...props({ turns, selection: { kind: "cut", id: "c1" } })}
      />,
    );
    expect(pill()).not.toHaveAttribute("data-in-selection");
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ScriptPane selection handles", () => {
  const handles = () => ({
    start: screen.getByRole("slider", { name: "Selection start" }),
    end: screen.getByRole("slider", { name: "Selection end" }),
  });

  it("draws a grip at each end of a run of words, named for the word it sits on", () => {
    layoutInGrid();
    render(<ScriptPane {...props({ selection: words(12, 14) })} />);
    const { start, end } = handles();
    expect(
      [start, end].map((h) => [
        h.getAttribute("aria-valuenow"),
        h.getAttribute("aria-valuemax"),
        h.getAttribute("aria-valuetext"),
        h.getAttribute("tabindex"),
      ]),
    ).toEqual([
      ["13", "54", "before small", "-1"],
      ["15", "54", "after can", "-1"],
    ]);
  });

  it("draws none for a cut, a guest without select, a read-only pane or when off", () => {
    layoutInGrid();
    const { rerender } = render(
      <ScriptPane {...props({ selection: { kind: "cut", id: "x" } })} />,
    );
    expect(screen.queryAllByRole("slider")).toEqual([]);
    rerender(
      <ScriptPane
        {...props({ onSelect: undefined, selection: words(12, 14) })}
      />,
    );
    expect(screen.queryAllByRole("slider")).toEqual([]);
    rerender(
      <ScriptPane {...props({ handles: false, selection: words(12, 14) })} />,
    );
    expect(screen.queryAllByRole("slider")).toEqual([]);
    rerender(<ScriptPane {...props({ selection: words(12, 14) })} />);
    expect(screen.getAllByRole("slider")).toHaveLength(2);
  });

  it("moves an edge a word at a time with the arrows, and to the ends with Home and End", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect, selection: words(12, 14) })} />);
    const { start, end } = handles();
    start.focus();
    await user.keyboard("{ArrowLeft}{ArrowRight}{Home}");
    end.focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{End}");
    expect(onSelect.mock.calls).toEqual([
      [words(11, 14)],
      [words(13, 14)],
      [words(0, 14)],
      [words(12, 15)],
      [words(12, 13)],
      [words(12, 53)],
    ]);
  });

  it("reports the word under the caret while an edge is dragged", () => {
    layoutInGrid();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect, selection: words(12, 14) })} />);
    const { start, end } = handles();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 130, clientY: 112 });
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(end, { pointerId: 1 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(start, { pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(start, { pointerId: 3, clientX: 70, clientY: 30 });
    expect(onSelect.mock.calls).toEqual([[words(12, 22)], [words(6, 14)]]);
  });
});

describe("ScriptPane Fix text focus", () => {
  it("returns focus to the first edited word when the field closes", () => {
    const editor = () => (
      <input
        aria-label="Fix text"
        defaultValue="small"
        ref={(el) => el?.focus()}
      />
    );
    const { rerender } = render(<ScriptPane {...props()} />);
    word("small").focus();
    rerender(
      <ScriptPane
        {...props({ editing: { start: 12, end: 12 }, renderEditor: editor })}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Fix text" })).toHaveFocus();
    rerender(<ScriptPane {...props()} />);
    expect(word("small")).toHaveFocus();
  });

  it("leaves focus alone when it moved elsewhere before the field closed", () => {
    const editor = () => (
      <input
        aria-label="Fix text"
        defaultValue="small"
        ref={(el) => el?.focus()}
      />
    );
    const tree = (editing: boolean) => (
      <>
        <ScriptPane
          {...props(
            editing
              ? { editing: { start: 12, end: 12 }, renderEditor: editor }
              : {},
          )}
        />
        <button type="button">Elsewhere</button>
      </>
    );
    const { rerender } = render(tree(false));
    word("small").focus();
    rerender(tree(true));
    word("Elsewhere").focus();
    rerender(tree(false));
    expect(word("Elsewhere")).toHaveFocus();
  });
});
