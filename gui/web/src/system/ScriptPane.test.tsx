import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScriptPane,
  type ScriptPaneHandle,
  type ScriptPaneProps,
} from "./ScriptPane";
import {
  CUT,
  cutMark,
  MUTED,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";
import { CENTER, NEAREST, probeScript } from "./scriptScrollProbe";

function props(over: Partial<ScriptPaneProps> = {}): ScriptPaneProps {
  return {
    turns: SCRIPT_TURNS,
    onCaret: vi.fn(),
    onSelect: vi.fn(),
    onSeek: vi.fn(),
    onPrimary: vi.fn(),
    onSeamSelect: vi.fn(),
    onSuggestionSelect: vi.fn(),
    onFind: vi.fn(),
    onNextUnsure: vi.fn(),
    onShowCutTextChange: vi.fn(),
    onFollowChange: vi.fn(),
    onBackToPlayhead: vi.fn(),
    ...over,
  };
}

const word = (name: string) => screen.getByRole("button", { name });
const words = (anchor: number, head: number) => ({
  kind: "words" as const,
  anchor,
  head,
});

/** Cuts, a suggestion and muted words among the plain ones. */
const MARKED = patchWords(SCRIPT_TURNS, {
  ...spanPatch(2, 3, { mark: cutMark("c1", 0.7) }),
  ...spanPatch(6, 7, { mark: suggestedMark("s1") }),
  ...spanPatch(12, 13, { mark: MUTED }),
  ...spanPatch(46, 48, { mark: CUT }),
});

const tabbable = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".sys-script-body *")]
    .filter((el) => el.tabIndex >= 0)
    .map((el) => el.getAttribute("aria-label") ?? el.textContent);

describe("ScriptPane turns", () => {
  it("names each turn by first name and time and drops a repeated name", () => {
    render(<ScriptPane {...props()} />);
    expect(
      screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Maya, 12:04", "Anneke, 12:19", "Anneke, 12:41", "Maya, 12:47"]);
    expect(screen.getAllByText("Anneke")).toHaveLength(1);
    expect(screen.getAllByText("Maya")).toHaveLength(2);
  });

  it("makes the speaker and the time buttons only when the host listens, and leaves them out of the tab order", async () => {
    const user = userEvent.setup();
    const onSeekTurn = vi.fn();
    const onSpeaker = vi.fn();
    const { container, rerender } = render(<ScriptPane {...props()} />);
    expect(container.querySelector(".sys-script-time")?.tagName).toBe("SPAN");
    rerender(<ScriptPane {...props({ onSeekTurn, onSpeaker })} />);
    await user.click(word("Play from 12:19"));
    expect(onSeekTurn).toHaveBeenCalledWith("t2");
    await user.click(word("Anneke de Vries, change speaker"));
    expect(onSpeaker).toHaveBeenCalledWith("t2", expect.any(HTMLButtonElement));
    expect(word("Play from 12:19")).toHaveAttribute("tabindex", "-1");
    expect(
      screen
        .getAllByRole("button", { name: "Maya Okafor, change speaker" })
        .map((b) => b.getAttribute("tabindex")),
    ).toEqual(["-1", "-1"]);
  });
});

describe("ScriptPane words", () => {
  it("places the caret and seeks on a click", async () => {
    const user = userEvent.setup();
    const onCaret = vi.fn();
    const onSeek = vi.fn();
    render(<ScriptPane {...props({ onCaret, onSeek })} />);
    await user.click(word("small"));
    expect(onCaret.mock.calls).toEqual([[12]]);
    expect(onSeek.mock.calls).toEqual([[12]]);
  });

  it("extends from the caret on a Shift-click, and from the anchor once selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <ScriptPane {...props({ onSelect, carets: [{ before: 12 }] })} />,
    );
    await user.keyboard("{Shift>}");
    await user.click(word("can"));
    expect(onSelect.mock.calls).toEqual([[words(12, 14)]]);
    rerender(<ScriptPane {...props({ onSelect, selection: words(12, 14) })} />);
    await user.click(word("Welcome"));
    expect(onSelect.mock.calls[1]).toEqual([words(12, 0)]);
  });

  it("marks the selected, playing and several playing words by name and style", () => {
    const { container } = render(
      <ScriptPane {...props({ selection: words(14, 12), playing: [3, 22] })} />,
    );
    expect(
      [...container.querySelectorAll(".sys-script-word[data-selected]")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["small", "room", "can"]);
    expect(word("small (selected)")).not.toHaveAttribute("aria-pressed");
    expect(
      screen
        .getAllByRole("button", { current: true })
        .map((button) => button.textContent),
    ).toEqual(["the", "having"]);
  });

  it("reads the selected range from a polite live region", () => {
    const { rerender } = render(
      <ScriptPane {...props({ selection: words(12, 14) })} />,
    );
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("3 words selected: small room can");
    rerender(<ScriptPane {...props({ selection: null })} />);
    expect(live).toHaveTextContent("Selection cleared");
  });

  it("names cut, muted, unsure, restored and found words and the playing run", () => {
    render(
      <ScriptPane
        {...props({
          showCutText: true,
          playing: 7,
          matches: [
            { start: 0, end: 0 },
            { start: 1, end: 1 },
          ],
          currentMatch: 1,
          turns: patchWords(MARKED, {
            26: { lowConfidence: true },
            30: { restored: true },
          }),
        })}
      />,
    );
    expect(word("back (current match)")).toHaveAttribute(
      "data-found",
      "current",
    );
    expect(word("Welcome (match)")).toHaveAttribute("data-found", "match");
    expect(word("to (cut)")).toHaveAttribute("data-state", "cut");
    expect(word("small (muted)")).toHaveAttribute("data-state", "muted");
    expect(word("season (unsure)")).toHaveAttribute("data-unsure", "");
    expect(word("getting (restored)")).toHaveAttribute("data-restored", "");
    expect(word("Suggested cut: we are")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("draws your caret hidden and another person's with their name, once even inside a muted run", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          turns: MARKED,
          carets: [
            { before: 30 },
            { before: 13, person: { name: "Joss", colorIndex: 2 } },
          ],
        })}
      />,
    );
    expect(screen.getAllByText("Joss's cursor")).toHaveLength(1);
    expect(container.querySelectorAll(".sys-script-caret")).toHaveLength(2);
    expect(
      container.querySelector(".sys-script-caret[data-own]"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("puts a caret that falls inside a cut before its pill", () => {
    const { container } = render(
      <ScriptPane {...props({ carets: [{ before: 47 }], turns: MARKED })} />,
    );
    expect(
      container.querySelector(".sys-script-caret + .sys-script-pill"),
    ).not.toBeNull();
  });
});

describe("ScriptPane one tab stop", () => {
  it("leaves one stop in the tab order, counting cut pills, runs and muted words", () => {
    const { container } = render(
      <ScriptPane {...props({ turns: MARKED, carets: [{ before: 30 }] })} />,
    );
    expect(tabbable(container)).toEqual(["getting"]);
  });

  it("falls back to the playing word, then the first", () => {
    const { rerender } = render(<ScriptPane {...props({ playing: 8 })} />);
    expect(word("talking")).toHaveAttribute("tabindex", "0");
    rerender(<ScriptPane {...props()} />);
    expect(word("Welcome")).toHaveAttribute("tabindex", "0");
  });

  it("starts the tab stop on the pill that holds the caret", () => {
    const { container } = render(
      <ScriptPane {...props({ turns: MARKED, carets: [{ before: 3 }] })} />,
    );
    expect(tabbable(container)).toEqual(["Cut, 0.7 s removed"]);
  });

  it("walks onto a pill and a run by arrow and takes the tab stop along", async () => {
    const user = userEvent.setup();
    const { container } = render(<ScriptPane {...props({ turns: MARKED })} />);
    word("back").focus();
    await user.keyboard("{ArrowRight}");
    expect(word("Cut, 0.7 s removed")).toHaveFocus();
    expect(tabbable(container)).toEqual(["Cut, 0.7 s removed"]);
    await user.keyboard("{ArrowRight}");
    expect(word("show.")).toHaveFocus();
    expect(tabbable(container)).toEqual(["show."]);
  });

  it("leaves the pane on Tab", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ScriptPane {...props({ turns: MARKED })} />
        <button type="button">After</button>
      </>,
    );
    word("Welcome").focus();
    await user.tab();
    expect(word("After")).toHaveFocus();
  });
});

describe("ScriptPane keyboard", () => {
  it("moves a word at a time across turns and reports the caret", async () => {
    const user = userEvent.setup();
    const onCaret = vi.fn();
    render(<ScriptPane {...props({ onCaret })} />);
    word("one.").focus();
    await user.keyboard("{ArrowRight}");
    expect(word("Thanks")).toHaveFocus();
    expect(word("Thanks")).toHaveAttribute("tabindex", "0");
    expect(word("Welcome")).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(word("large")).toHaveFocus();
    expect(onCaret.mock.calls).toEqual([[20], [19], [18]]);
  });

  it("reports the start of a pill as the caret, and does not seek on arrows", async () => {
    const user = userEvent.setup();
    const onCaret = vi.fn();
    const onSeek = vi.fn();
    render(<ScriptPane {...props({ turns: MARKED, onCaret, onSeek })} />);
    word("back").focus();
    await user.keyboard("{ArrowRight}");
    expect(onCaret.mock.calls).toEqual([[2]]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("jumps to the first and last stop with Home and End and stops at the ends", async () => {
    const user = userEvent.setup();
    const onCaret = vi.fn();
    render(<ScriptPane {...props({ onCaret })} />);
    word("small").focus();
    await user.keyboard("{End}");
    expect(word("first?")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(word("first?")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(word("Welcome")).toHaveFocus();
    expect(onCaret.mock.calls).toEqual([[53], [0]]);
  });

  it("extends from the real anchor after plain arrows moved the caret", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect })} />);
    await user.click(word("Welcome"));
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // The click selected the word at once; the plain arrows then moved only the caret.
    expect(onSelect.mock.calls).toEqual([[words(0, 0)], [words(3, 4)]]);
    expect(word("back")).not.toHaveFocus();
  });

  it("keeps the anchor while the selection grows and shrinks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<ScriptPane {...props({ onSelect })} />);
    word("sound").focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onSelect).toHaveBeenLastCalledWith(words(15, 16));
    rerender(<ScriptPane {...props({ onSelect, selection: words(15, 16) })} />);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onSelect).toHaveBeenLastCalledWith(words(15, 17));
    rerender(<ScriptPane {...props({ onSelect, selection: words(15, 17) })} />);
    await user.keyboard("{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}");
    expect(onSelect.mock.calls.slice(2)).toEqual([
      [words(15, 16)],
      [words(15, 15)],
    ]);
  });

  it("reports Shift+End and Shift+Home", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ onSelect })} />);
    word("sound").focus();
    await user.keyboard("{Shift>}{End}{/Shift}");
    expect(onSelect.mock.calls).toEqual([[words(15, 53)]]);
    expect(word("first?")).toHaveFocus();
  });

  it("takes a whole pill and a whole run when the selection reaches onto them", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScriptPane {...props({ turns: MARKED, onSelect })} />);
    word("back").focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onSelect).toHaveBeenLastCalledWith(words(1, 3));
    word("show.").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(word("Suggested cut: we are")).toHaveFocus();
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(onSelect).toHaveBeenLastCalledWith(words(7, 5));
  });

  it("leaves Space to Play/Pause on a word, a pill and a run", async () => {
    const user = userEvent.setup();
    const handlers = props({ turns: MARKED });
    render(<ScriptPane {...handlers} />);
    for (const name of [
      "back",
      "Cut, 0.7 s removed",
      "Suggested cut: we are",
    ]) {
      const target = word(name);
      target.focus();
      expect(fireEvent.keyDown(target, { key: " " })).toBe(true);
      await user.keyboard(" ");
    }
    expect(handlers.onCaret).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onSeek).not.toHaveBeenCalled();
    expect(handlers.onPrimary).not.toHaveBeenCalled();
    expect(handlers.onSeamSelect).not.toHaveBeenCalled();
    expect(handlers.onSuggestionSelect).not.toHaveBeenCalled();
  });

  it("selects and seeks on Enter for an unselected word, and runs the primary for a selected one", async () => {
    const user = userEvent.setup();
    const handlers = props();
    const { rerender } = render(<ScriptPane {...handlers} />);
    word("small").focus();
    await user.keyboard("{Enter}");
    expect(handlers.onSelect).toHaveBeenCalledWith(words(12, 12));
    expect(handlers.onSeek).toHaveBeenCalledWith(12);
    expect(handlers.onPrimary).not.toHaveBeenCalled();
    rerender(<ScriptPane {...handlers} selection={words(12, 14)} />);
    await user.keyboard("{Enter}");
    expect(handlers.onPrimary).toHaveBeenCalledOnce();
    expect(handlers.onSeek).toHaveBeenCalledOnce();
    expect(handlers.onSelect).toHaveBeenCalledOnce();
  });

  it("selects a pill on Enter through the pill's own button", async () => {
    const user = userEvent.setup();
    const onSeamSelect = vi.fn();
    render(<ScriptPane {...props({ turns: MARKED, onSeamSelect })} />);
    word("Cut, 0.7 s removed").focus();
    await user.keyboard("{Enter}");
    expect(onSeamSelect).toHaveBeenCalledWith("c1");
  });

  it("leaves keys alone inside the Fix text field", async () => {
    const user = userEvent.setup();
    const handlers = props();
    render(
      <ScriptPane
        {...handlers}
        editing={{ start: 12, end: 13 }}
        renderEditor={() => (
          <input aria-label="Fix text" defaultValue="small room" />
        )}
      />,
    );
    expect(screen.queryByRole("button", { name: "small" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "room" })).toHaveLength(1);
    const field = screen.getByRole("textbox", { name: "Fix text" });
    field.focus();
    await user.keyboard("{ArrowLeft}{Home}{Enter} ");
    expect(field).toHaveFocus();
    expect(handlers.onCaret).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it("sends focus to the pill that replaces a word that was cut", () => {
    const { rerender } = render(<ScriptPane {...props()} />);
    word("um,").focus();
    rerender(<ScriptPane {...props({ turns: MARKED })} />);
    expect(word("Cut, 1.1 s removed")).toHaveFocus();
    expect(word("Cut, 1.1 s removed")).toHaveAttribute("tabindex", "0");
  });

  it("sends focus to the next stop when the focused one is gone", () => {
    const { rerender } = render(<ScriptPane {...props()} />);
    word("Thanks").focus();
    rerender(<ScriptPane {...props({ turns: SCRIPT_TURNS.slice(2) })} />);
    expect(word("That")).toHaveFocus();
  });

  it("does not take focus back when it was elsewhere", () => {
    const { rerender } = render(
      <>
        <ScriptPane {...props()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    word("um,").focus();
    word("Elsewhere").focus();
    rerender(
      <>
        <ScriptPane {...props({ turns: MARKED })} />
        <button type="button">Elsewhere</button>
      </>,
    );
    expect(word("Elsewhere")).toHaveFocus();
  });
});

describe("ScriptPane marks", () => {
  it("collapses cuts into pills with the measured length and reports the id", async () => {
    const user = userEvent.setup();
    const onSeamSelect = vi.fn();
    render(
      <ScriptPane
        {...props({
          onSeamSelect,
          selection: { kind: "cut", id: "cut-1" },
          turns: patchWords(SCRIPT_TURNS, {
            ...spanPatch(46, 48, { mark: CUT }),
            ...spanPatch(28, 28, { mark: cutMark("cut-2", 0.3) }),
            ...spanPatch(29, 29, { mark: cutMark("cut-3", 0.4) }),
          }),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "um," })).toBeNull();
    expect(word("Cut, 1.1 s removed")).toHaveAttribute("aria-pressed", "true");
    expect(word("Cut, 0.3 s removed")).toHaveAttribute("aria-pressed", "false");
    await user.click(word("Cut, 0.4 s removed"));
    expect(onSeamSelect).toHaveBeenCalledWith("cut-3");
  });

  it("selects a cut or a suggestion without selecting words", () => {
    const { container, rerender } = render(
      <ScriptPane
        {...props({ turns: MARKED, selection: { kind: "cut", id: "c1" } })}
      />,
    );
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "true");
    expect(
      container.querySelector(".sys-script-word[data-selected]"),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cut selected, 0.7 s removed",
    );
    rerender(
      <ScriptPane
        {...props({
          turns: MARKED,
          selection: { kind: "suggestion", id: "s1" },
        })}
      />,
    );
    expect(word("Suggested cut: we are")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(word("Cut, 0.7 s removed")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows cut words struck when the text shows", () => {
    render(<ScriptPane {...props({ showCutText: true, turns: MARKED })} />);
    expect(word("um, (cut)")).toHaveAttribute("data-state", "cut");
    expect(screen.queryByRole("button", { name: /^Cut, 1/ })).toBeNull();
  });

  it("draws a suggested run as one hatched button and keeps two apart", async () => {
    const user = userEvent.setup();
    const onSuggestionSelect = vi.fn();
    render(
      <ScriptPane
        {...props({
          onSuggestionSelect,
          turns: patchWords(SCRIPT_TURNS, {
            ...spanPatch(46, 46, { mark: suggestedMark("a") }),
            ...spanPatch(47, 48, { mark: suggestedMark("b") }),
          }),
        })}
      />,
    );
    const run = word("Suggested cut: you know,");
    expect(within(run).getByText("Removed:")).toBeInTheDocument();
    await user.click(run);
    await user.click(word("Suggested cut: um,"));
    expect(onSuggestionSelect.mock.calls).toEqual([["b"], ["a"]]);
  });

  it("puts muted words behind a glyph and names each one", () => {
    const { container } = render(<ScriptPane {...props({ turns: MARKED })} />);
    expect(container.querySelector(".sys-script-muted svg")).not.toBeNull();
    expect(word("small (muted)")).toHaveAttribute("data-state", "muted");
    expect(word("room (muted)")).toHaveAttribute("data-state", "muted");
    expect(word("can")).not.toHaveAttribute("data-state");
  });
});

describe("ScriptPane handle and scrolling", () => {
  let probe: ReturnType<typeof probeScript> | undefined;
  afterEach(() => probe?.restore());
  const mount = (wordTop?: number) => {
    const ref = createRef<ScriptPaneHandle>();
    render(<ScriptPane {...props({ turns: MARKED })} ref={ref} />);
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    probe = probeScript(body, wordTop);
    return { ref, body };
  };

  it("scrolls to the stop that holds a word and says when it is not shown", () => {
    const { ref } = mount();
    expect(ref.current?.scrollToWord(47, "center")).toBe(true);
    expect(probe?.calls).toHaveLength(1);
    expect(probe?.calls[0]?.[1]).toBe(CENTER);
    expect(probe?.calls[0]?.[0]).toBe(
      document.querySelector('.sys-script-pill[data-stop="46"]')?.textContent,
    );
    expect(ref.current?.scrollToWord(900)).toBe(false);
  });

  it("lands a word below the view at its bottom edge by default and for nearest", () => {
    const { ref, body } = mount();
    const landed = (block?: ScrollLogicalPosition) => {
      body.scrollTop = 0;
      probe?.calls.splice(0);
      ref.current?.scrollToWord(47, block);
      return probe?.calls.map((c) => c[1]);
    };
    expect(landed()).toEqual([NEAREST]);
    expect(landed("nearest")).toEqual([NEAREST]);
  });

  it("leaves a word that is already in view where it is by default", () => {
    const { ref, body } = mount(50);
    body.scrollTop = 500;
    probe?.calls.splice(0);
    expect(ref.current?.scrollToWord(47)).toBe(true);
    expect(probe?.calls).toEqual([]);
  });

  it("brings a word above the view to its top by default", () => {
    const { ref, body } = mount(-300);
    body.scrollTop = 500;
    probe?.calls.splice(0);
    ref.current?.scrollToWord(47);
    expect(probe?.calls.map((c) => c[1])).toEqual([200]);
  });

  it("puts a word at the top of the view for start and at the bottom for end", () => {
    const { ref, body } = mount();
    const landed = (block: ScrollLogicalPosition) => {
      body.scrollTop = 0;
      probe?.calls.splice(0);
      ref.current?.scrollToWord(47, block);
      return probe?.calls.map((c) => c[1]);
    };
    expect(landed("start")).toEqual([1000]);
    expect(landed("end")).toEqual([820]);
  });

  it("tells the host about a scroll only after the reader's own input", () => {
    const onUserScroll = vi.fn();
    const { container } = render(<ScriptPane {...props({ onUserScroll })} />);
    const body = container.querySelector(".sys-script-body") as HTMLElement;
    fireEvent.scroll(body);
    expect(onUserScroll).not.toHaveBeenCalled();
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });
});

describe("ScriptPane read only", () => {
  it("renders with no callbacks and draws no control it could not serve", async () => {
    const user = userEvent.setup();
    render(
      <ScriptPane
        turns={MARKED}
        guest="viewer"
        following={false}
        playing={3}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Find in transcript" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show cut text" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Follow the playhead" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
    await user.click(word("Welcome"));
    await user.click(word("Cut, 0.7 s removed"));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}{Enter}");
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("takes the unsure count from the host when it shows only a window", () => {
    render(
      <ScriptPane
        {...props({
          unsureCount: 7,
          turns: patchWords(SCRIPT_TURNS, { 26: { lowConfidence: true } }),
        })}
      />,
    );
    expect(word("7 unsure words, go to the next")).toBeInTheDocument();
  });
});

describe("ScriptPane header", () => {
  it("opens find and toggles the eye and the pin", async () => {
    const user = userEvent.setup();
    const onFind = vi.fn();
    const onShowCutTextChange = vi.fn();
    const onFollowChange = vi.fn();
    render(
      <ScriptPane
        {...props({ onFind, onShowCutTextChange, onFollowChange })}
      />,
    );
    await user.click(word("Find in transcript"));
    await user.click(word("Show cut text"));
    await user.click(word("Follow the playhead"));
    expect(onFind).toHaveBeenCalledOnce();
    expect(onShowCutTextChange).toHaveBeenCalledWith(true);
    expect(onFollowChange).toHaveBeenCalledWith(false);
    expect(word("Show cut text")).toHaveAttribute("aria-pressed", "false");
    expect(word("Follow the playhead")).toHaveAttribute("aria-pressed", "true");
  });

  it("counts unsure words and jumps to the next, and hides the chip at zero", async () => {
    const user = userEvent.setup();
    const onNextUnsure = vi.fn();
    const turns = patchWords(SCRIPT_TURNS, {
      26: { lowConfidence: true },
      37: { lowConfidence: true },
    });
    const { rerender } = render(
      <ScriptPane {...props({ turns, onNextUnsure })} />,
    );
    await user.click(word("2 unsure words, go to the next"));
    expect(onNextUnsure).toHaveBeenCalledOnce();
    rerender(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, { 26: { lowConfidence: true } }),
        })}
      />,
    );
    expect(word("1 unsure word, go to the next")).toBeInTheDocument();
    rerender(<ScriptPane {...props()} />);
    expect(screen.queryByRole("button", { name: /unsure/ })).toBeNull();
  });

  it("marks a guest as read only", () => {
    const { rerender } = render(<ScriptPane {...props({ guest: "viewer" })} />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
    rerender(<ScriptPane {...props({ guest: "commenter" })} />);
    expect(screen.getByText("Read only · you can comment")).toBeInTheDocument();
  });
});

describe("ScriptPane status", () => {
  it("offers Back to playhead only when it is not following a playing word", async () => {
    const user = userEvent.setup();
    const onBackToPlayhead = vi.fn();
    const { rerender } = render(
      <ScriptPane
        {...props({ following: false, playing: 4, onBackToPlayhead })}
      />,
    );
    await user.click(word("Back to playhead"));
    expect(onBackToPlayhead).toHaveBeenCalledOnce();
    rerender(<ScriptPane {...props({ following: true, playing: 4 })} />);
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
    rerender(<ScriptPane {...props({ following: false })} />);
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
  });

  it("shows the percent and the untranscribed time while transcribing", () => {
    render(
      <ScriptPane
        {...props({
          turns: SCRIPT_TURNS.slice(0, 1),
          status: {
            kind: "transcribing",
            progress: 0.42,
            notYet: "12:00 to 52:10",
          },
        })}
      />,
    );
    expect(
      screen.getByRole("progressbar", { name: "Transcribing" }),
    ).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(
      screen.getByText("Not transcribed yet · 12:00 to 52:10"),
    ).toBeInTheDocument();
  });

  it("asks to update an out-of-date transcript", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <ScriptPane {...props({ status: { kind: "outOfDate", onUpdate } })} />,
    );
    expect(screen.getByText("Transcript out of date")).toBeInTheDocument();
    await user.click(word("Update"));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("shows the Cover with the one button when there is no transcript", async () => {
    const user = userEvent.setup();
    const onTranscribe = vi.fn();
    render(
      <ScriptPane
        {...props({ turns: [], status: { kind: "empty", onTranscribe } })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No transcript yet" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Find in transcript" }),
    ).toBeNull();
    await user.click(word("Transcribe this episode"));
    expect(onTranscribe).toHaveBeenCalledOnce();
  });

  it("shows the skeleton instead of turns while loading", () => {
    const { container } = render(
      <ScriptPane
        {...props({ turns: [], status: { kind: "loading", elapsedMs: 1000 } })}
      />,
    );
    expect(container.querySelector(".sys-skeleton")).toHaveAttribute(
      "data-phase",
      "blocks",
    );
    expect(screen.queryByRole("group")).toBeNull();
  });
});
