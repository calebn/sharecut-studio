import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScriptPane, type ScriptPaneProps } from "./ScriptPane";
import { patchWords, SCRIPT_TURNS, spanPatch } from "./scriptFixtures";

function props(over: Partial<ScriptPaneProps> = {}): ScriptPaneProps {
  return {
    turns: SCRIPT_TURNS,
    onWord: vi.fn(),
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

describe("ScriptPane turns", () => {
  it("names each turn by first name and time and drops a repeated name", () => {
    render(<ScriptPane {...props()} />);
    expect(
      screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Maya, 12:04", "Anneke, 12:19", "Anneke, 12:41", "Maya, 12:47"]);
    expect(screen.getAllByText("Anneke")).toHaveLength(1);
    expect(screen.getAllByText("Maya")).toHaveLength(2);
  });

  it("reports a pressed word, and Shift as an extension", async () => {
    const user = userEvent.setup();
    const onWord = vi.fn();
    render(<ScriptPane {...props({ onWord })} />);
    await user.click(word("small"));
    await user.keyboard("{Shift>}");
    await user.click(word("can"));
    expect(onWord.mock.calls).toEqual([
      [12, false],
      [14, true],
    ]);
  });

  it("marks the selected words and the playing word", () => {
    const { container } = render(
      <ScriptPane
        {...props({ selection: { start: 12, end: 14 }, playing: 3 })}
      />,
    );
    expect(
      [...container.querySelectorAll(".sys-script-word[data-selected]")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["small", "room", "can"]);
    expect(screen.getAllByRole("button", { current: true })).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { current: true })[0],
    ).toHaveTextContent("the");
  });
});

describe("ScriptPane keyboard", () => {
  it("leaves one word in the tab order, at the caret", () => {
    render(<ScriptPane {...props({ carets: [{ before: 12 }] })} />);
    const stops = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0")
      .map((b) => b.textContent);
    expect(stops).toEqual(["small"]);
  });

  it("falls back to the playing word, then the first", () => {
    const { rerender } = render(<ScriptPane {...props({ playing: 8 })} />);
    expect(word("talking")).toHaveAttribute("tabindex", "0");
    rerender(<ScriptPane {...props()} />);
    expect(word("Welcome")).toHaveAttribute("tabindex", "0");
  });

  it("moves focus a word at a time, across turns, and takes the tab stop along", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...props()} />);
    word("one.").focus();
    await user.keyboard("{ArrowRight}");
    expect(word("Thanks")).toHaveFocus();
    expect(word("Thanks")).toHaveAttribute("tabindex", "0");
    expect(word("Welcome")).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(word("large")).toHaveFocus();
  });

  it("jumps to the first and last word with Home and End and stops at the ends", async () => {
    const user = userEvent.setup();
    render(<ScriptPane {...props()} />);
    word("small").focus();
    await user.keyboard("{End}");
    expect(word("first?")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(word("first?")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(word("Welcome")).toHaveFocus();
  });

  it("extends the selection with Shift and an arrow", async () => {
    const user = userEvent.setup();
    const onWord = vi.fn();
    render(<ScriptPane {...props({ onWord })} />);
    word("sound").focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onWord.mock.calls).toEqual([[16, true]]);
    expect(word("like")).toHaveFocus();
  });

  it("reaches a cut pill by arrow and leaves it again", async () => {
    const user = userEvent.setup();
    render(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { state: "cut" })),
        })}
      />,
    );
    word("So,").focus();
    await user.keyboard("{ArrowRight}");
    expect(word("Cut, 0.9 s removed")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(word("what")).toHaveFocus();
  });
});

describe("ScriptPane word states", () => {
  it("collapses cuts into pills and selects one", async () => {
    const user = userEvent.setup();
    const onSeamSelect = vi.fn();
    render(
      <ScriptPane
        {...props({
          onSeamSelect,
          selectedCut: 46,
          turns: patchWords(SCRIPT_TURNS, {
            ...spanPatch(46, 48, { state: "cut" }),
            28: { state: "cut" },
          }),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "um," })).toBeNull();
    expect(word("Cut, 0.9 s removed")).toHaveAttribute("aria-pressed", "true");
    expect(word("Cut, 0.3 s removed")).toHaveAttribute("aria-pressed", "false");
    await user.click(word("Cut, 0.3 s removed"));
    expect(onSeamSelect).toHaveBeenCalledWith({ start: 28, end: 28 });
  });

  it("shows cut words struck when the text shows", () => {
    render(
      <ScriptPane
        {...props({
          showCutText: true,
          turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { state: "cut" })),
        })}
      />,
    );
    expect(word("um,")).toHaveAttribute("data-state", "cut");
    expect(screen.queryByRole("button", { name: /^Cut, / })).toBeNull();
  });

  it("draws a suggested run as one hatched button", async () => {
    const user = userEvent.setup();
    const onSuggestionSelect = vi.fn();
    render(
      <ScriptPane
        {...props({
          onSuggestionSelect,
          turns: patchWords(
            SCRIPT_TURNS,
            spanPatch(46, 48, { state: "suggested" }),
          ),
        })}
      />,
    );
    const run = word("Suggested cut: um, you know,");
    expect(within(run).getByText("Removed:")).toBeInTheDocument();
    await user.click(run);
    expect(onSuggestionSelect).toHaveBeenCalledWith({ start: 46, end: 48 });
  });

  it("puts muted words behind a labelled glyph", () => {
    render(
      <ScriptPane
        {...props({
          turns: patchWords(
            SCRIPT_TURNS,
            spanPatch(15, 16, { state: "muted" }),
          ),
        })}
      />,
    );
    expect(screen.getByText("Muted:")).toBeInTheDocument();
    expect(word("sound")).toHaveAttribute("data-state", "muted");
    expect(word("like")).toHaveAttribute("data-state", "muted");
    expect(word("large")).not.toHaveAttribute("data-state");
  });

  it("says unsure and restored words in the name as well as the style", () => {
    render(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, {
            26: { lowConfidence: true },
            46: { restored: true },
          }),
        })}
      />,
    );
    expect(word("season (unsure)")).toHaveAttribute("data-unsure", "");
    expect(word("um, (restored)")).toHaveAttribute("data-restored", "");
  });

  it("draws your caret hidden and another person's with their name", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          carets: [
            { before: 12 },
            { before: 30, person: { name: "Joss", colorIndex: 2 } },
          ],
        })}
      />,
    );
    expect(screen.getByText("Joss's cursor")).toBeInTheDocument();
    const own = container.querySelector(".sys-script-caret[data-own]");
    expect(own).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".sys-script-caret")).toHaveLength(2);
  });

  it("puts a caret that falls inside a cut before its pill", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          carets: [{ before: 47 }],
          turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { state: "cut" })),
        })}
      />,
    );
    expect(
      container.querySelector(".sys-script-caret + .sys-script-pill"),
    ).not.toBeNull();
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
    await user.click(word("? 2 unsure words, go to the next"));
    expect(onNextUnsure).toHaveBeenCalledOnce();
    rerender(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, { 26: { lowConfidence: true } }),
        })}
      />,
    );
    expect(word("? 1 unsure word, go to the next")).toBeInTheDocument();
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
