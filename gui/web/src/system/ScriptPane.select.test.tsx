import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScriptPane,
  type ScriptPaneHandle,
  type ScriptPaneProps,
} from "./ScriptPane";
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
      [
        "Cut, 1.5 s removed, continues in the next turn",
        "Cut, continued from the previous turn",
      ].map((name) => word(name).getAttribute("aria-pressed")),
    ).toEqual(["true", "true"]);
  });

  it("shows the measured length once when a cut crosses a turn boundary", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(18, 21, { mark: cutMark("x", 1.5) }),
    });
    const { container } = render(<ScriptPane {...props({ turns })} />);
    const pills = [...container.querySelectorAll(".sys-seam-hit")].map(
      (el) => el.textContent,
    );
    expect(pills).toEqual(["1.5 s", "continued"]);
    expect(screen.queryAllByText("1.5 s")).toHaveLength(1);
  });

  it("names a cut inside one turn plainly", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 3, { mark: cutMark("a", 0.7) }),
    });
    render(<ScriptPane {...props({ turns })} />);
    expect(word("Cut, 0.7 s removed")).toBeVisible();
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
  const grips = (container: HTMLElement) => ({
    start: container.querySelector<HTMLElement>(".sys-handle[data-edge=start]"),
    end: container.querySelector<HTMLElement>(".sys-handle[data-edge=end]"),
  });

  it("draws a pointer-only grip at each end of a run of words", () => {
    layoutInGrid();
    const { container } = render(
      <ScriptPane {...props({ selection: words(12, 14) })} />,
    );
    const { start, end } = grips(container);
    for (const grip of [start, end]) {
      expect(grip).toHaveAttribute("aria-hidden", "true");
      expect(grip).not.toHaveAttribute("tabindex");
    }
    expect(screen.queryAllByRole("slider")).toEqual([]);
    const tabbable = [
      ...container.querySelectorAll<HTMLElement>(".sys-script-body *"),
    ].filter((el) => el.tabIndex >= 0);
    expect(tabbable.map((el) => el.textContent)).toEqual(["Welcome"]);
  });

  it("draws none for a cut, a guest without select, a read-only pane or when off", () => {
    layoutInGrid();
    const { container, rerender } = render(
      <ScriptPane {...props({ selection: { kind: "cut", id: "x" } })} />,
    );
    const count = () => container.querySelectorAll(".sys-handle").length;
    expect(count()).toBe(0);
    rerender(
      <ScriptPane
        {...props({ onSelect: undefined, selection: words(12, 14) })}
      />,
    );
    expect(count()).toBe(0);
    rerender(
      <ScriptPane {...props({ handles: false, selection: words(12, 14) })} />,
    );
    expect(count()).toBe(0);
    rerender(<ScriptPane {...props({ selection: words(12, 14) })} />);
    expect(count()).toBe(2);
  });

  it("reports the word under the caret while an edge is dragged", () => {
    layoutInGrid();
    const onSelect = vi.fn();
    const { container } = render(
      <ScriptPane {...props({ onSelect, selection: words(12, 14) })} />,
    );
    const { start, end } = grips(container);
    if (!start || !end) throw new Error("No grips");
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 130, clientY: 112 });
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(end, { pointerId: 1 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(start, { pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(start, { pointerId: 3, clientX: 70, clientY: 30 });
    expect(onSelect.mock.calls).toEqual([[words(12, 22)], [words(6, 14)]]);
  });

  it("measures the places once while a grip is dragged, not once per move", () => {
    layoutInGrid();
    const { container } = render(
      <ScriptPane {...props({ selection: words(12, 14) })} />,
    );
    const end = grips(container).end;
    if (!end) throw new Error("No grip");
    const reads = () =>
      vi.mocked(HTMLElement.prototype.getClientRects).mock.calls.length;
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 100, clientY: 10 });
    const first = reads();
    for (const x of [110, 120, 130, 140, 150]) {
      fireEvent.pointerMove(end, { pointerId: 1, clientX: x, clientY: 10 });
    }
    expect(reads()).toBe(first);
  });

  it("holds the announcement until a grip is let go, then says the selection once", () => {
    layoutInGrid();
    const { container, rerender } = render(
      <ScriptPane {...props({ selection: words(12, 14) })} />,
    );
    const status = () => screen.getByRole("status");
    expect(status()).toHaveTextContent("3 words selected: small room can");
    const end = grips(container).end;
    if (!end) throw new Error("No grip");
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 130, clientY: 112 });
    rerender(<ScriptPane {...props({ selection: words(12, 16) })} />);
    rerender(<ScriptPane {...props({ selection: words(12, 22) })} />);
    expect(status()).toHaveTextContent("3 words selected: small room can");
    fireEvent.pointerUp(end, { pointerId: 1 });
    expect(status()).toHaveTextContent(/^11 words selected: /);
  });
});

describe("ScriptPane live region", () => {
  it("says the selection was cleared, and only after there was one", () => {
    const { rerender } = render(<ScriptPane {...props()} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    rerender(<ScriptPane {...props({ selection: words(12, 14) })} />);
    expect(screen.getByRole("status")).toHaveTextContent("3 words selected");
    rerender(<ScriptPane {...props({ selection: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Selection cleared");
  });

  it("speaks the Find bar's status in the same region and has no other", () => {
    const { rerender, container } = render(
      <ScriptPane {...props({ findStatus: "3 of 12" })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("3 of 12");
    rerender(<ScriptPane {...props({ findStatus: "No matches" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(
      container.querySelectorAll("[role=status], [aria-live]"),
    ).toHaveLength(1);
  });
});

describe("ScriptPane keys the window keymap must not see", () => {
  const reached = () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    return { seen, stop: () => window.removeEventListener("keydown", seen) };
  };

  it("stops the arrows, Home, End, Enter, Alt+Shift and Esc it handles", () => {
    layoutInGrid();
    const { seen, stop } = reached();
    render(<ScriptPane {...props({ selection: words(12, 14) })} />);
    const small = word("small (selected)");
    for (const init of [
      { key: "ArrowRight" },
      { key: "ArrowLeft", shiftKey: true },
      { key: "Home" },
      { key: "End" },
      { key: "Enter" },
      { key: "ArrowRight", altKey: true, shiftKey: true },
      { key: "Escape" },
    ]) {
      fireEvent.keyDown(small, init);
    }
    stop();
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops the margin controls' keys too", () => {
    const { seen, stop } = reached();
    render(
      <ScriptPane {...props({ onSpeaker: vi.fn(), onSeekTurn: vi.fn() })} />,
    );
    fireEvent.keyDown(
      screen.getAllByRole("button", { name: "Maya Okafor, change speaker" })[0],
      {
        key: "ArrowDown",
      },
    );
    stop();
    expect(seen).not.toHaveBeenCalled();
  });

  it("lets every other key and every Ctrl or Cmd chord through", () => {
    const { seen, stop } = reached();
    render(<ScriptPane {...props()} />);
    const welcome = word("Welcome");
    fireEvent.keyDown(welcome, { key: "m" });
    fireEvent.keyDown(welcome, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(welcome, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(welcome, { key: "Escape" });
    stop();
    expect(seen).toHaveBeenCalledTimes(4);
  });
});

describe("ScriptPane places are measured once per layout", () => {
  it("does not measure every word again on each arrow press, only after the layout changes", async () => {
    layoutInGrid();
    const user = userEvent.setup();
    const { rerender } = render(<ScriptPane {...props()} />);
    const reads = () =>
      vi.mocked(HTMLElement.prototype.getClientRects).mock.calls.length;
    word("sound").focus();
    await user.keyboard("{ArrowDown}");
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThanOrEqual(54);
    await user.keyboard("{ArrowUp}{ArrowDown}{ArrowUp}");
    expect(reads()).toBe(afterFirst);
    const wider = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 3, { mark: cutMark("c1", 0.7) }),
    });
    rerender(<ScriptPane {...props({ turns: wider })} />);
    word("sound").focus();
    await user.keyboard("{ArrowDown}");
    expect(reads()).toBeGreaterThan(afterFirst);
  });
});

describe("ScriptPane handle", () => {
  it("puts focus on the header's Find button for the Find bar to return to", () => {
    const handle = { current: null as ScriptPaneHandle | null };
    const { rerender } = render(
      <ScriptPane {...props({ onFind: vi.fn() })} ref={handle} />,
    );
    let ok = false;
    act(() => {
      ok = handle.current?.focusFind() ?? false;
    });
    expect(ok).toBe(true);
    expect(
      screen.getByRole("button", { name: "Find in transcript" }),
    ).toHaveFocus();
    rerender(<ScriptPane {...props()} ref={handle} />);
    expect(handle.current?.focusFind()).toBe(false);
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

describe("ScriptPane Fix text across turns", () => {
  it("draws one field, in the first turn, for the whole span", () => {
    const renderEditor = vi.fn((span: { start: number; end: number }) => (
      <input
        aria-label={`Fix text ${span.start}-${span.end}`}
        defaultValue="x"
      />
    ));
    render(
      <ScriptPane
        {...props({ editing: { start: 18, end: 22 }, renderEditor })}
      />,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("textbox")).toHaveAccessibleName("Fix text 18-22");
    expect(renderEditor).toHaveBeenCalledWith({ start: 18, end: 22 });
    for (const covered of [18, 19, 20, 21, 22]) {
      expect(document.querySelector(`[data-stop="${covered}"]`)).toBeNull();
    }
    expect(document.querySelector('[data-stop="17"]')).not.toBeNull();
    expect(document.querySelector('[data-stop="23"]')).not.toBeNull();
  });
});
