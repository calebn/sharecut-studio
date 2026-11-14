import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScriptPaneProps } from "./ScriptPane";
import { ScriptPane } from "./ScriptPane";
import {
  CUT,
  MUTED,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";

// A word renders once per call of wordLabel, so the calls count word renders.
const labelled = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./scriptPieces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scriptPieces")>();
  return {
    ...actual,
    wordLabel: (...args: Parameters<typeof actual.wordLabel>) => {
      labelled.calls.push(args[0].text);
      return actual.wordLabel(...args);
    },
  };
});

const TURNS = patchWords(SCRIPT_TURNS, {
  ...spanPatch(46, 48, { mark: CUT }),
  ...spanPatch(31, 32, { mark: suggestedMark("s1") }),
});

// New function identities on every render, as an inline host would pass them.
const props = (over: Partial<ScriptPaneProps> = {}): ScriptPaneProps => ({
  turns: TURNS,
  onCaret: () => {},
  onSelect: () => {},
  onSeek: () => {},
  onSeamSelect: () => {},
  onSuggestionSelect: () => {},
  ...over,
});

describe("ScriptPane refreshing", () => {
  it("marks the Script busy without an announcement, and clears it", () => {
    const { container, rerender } = render(
      <ScriptPane {...props({ busy: true })} />,
    );
    const section = container.querySelector(".sys-script");
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(section).toHaveAttribute("data-refreshing", "");
    expect(container.querySelector("[aria-live]:not(:empty)")).toBeNull();
    rerender(<ScriptPane {...props({ busy: false })} />);
    expect(container.querySelector(".sys-script")).toBe(section);
    expect(section).not.toHaveAttribute("aria-busy");
    expect(section).not.toHaveAttribute("data-refreshing");
  });

  it("draws a settling line as bars and a hidden note, with no word to reach", () => {
    const settling = {
      id: "settling",
      speakerId: "x",
      speaker: { name: "Sam", colorIndex: 2 },
      time: "1:00",
      words: [],
      settling: [5, 3],
    };
    const { container } = render(
      <ScriptPane {...props({ turns: [settling, ...TURNS] })} />,
    );
    const turn = container.querySelector(
      '[data-turn-id="settling"]',
    ) as HTMLElement;
    const bars = turn.querySelectorAll(".sys-script-settling-bar");
    expect(
      [...bars].map((bar) =>
        (bar as HTMLElement).style.getPropertyValue("--sys-settling-chars"),
      ),
    ).toEqual(["5", "3"]);
    expect(turn.querySelector(".sys-script-settling")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(turn.textContent).toContain("Updating this line");
    expect(turn.querySelector("[data-stop]")).toBeNull();
  });

  it("keeps a turn's word nodes when an earlier turn is removed and its words are renumbered", () => {
    const turn = (id: string, firstIndex: number, texts: string[]) => ({
      id,
      speakerId: "a",
      speaker: { name: "Ann", colorIndex: 0 },
      time: "0:00",
      words: texts.map((text, at) => ({
        index: firstIndex + at,
        key: `${id}:${at}`,
        text,
      })),
    });
    const { rerender } = render(
      <ScriptPane
        {...props({
          turns: [
            turn("a", 0, ["one", "two"]),
            turn("b", 2, ["three", "four"]),
          ],
        })}
      />,
    );
    const three = document.querySelector('[data-word-key="b:0"]');
    rerender(
      <ScriptPane {...props({ turns: [turn("b", 0, ["three", "four"])] })} />,
    );
    expect(document.querySelector('[data-word-key="b:0"]')).toBe(three);
  });
});

describe("ScriptPane renders", () => {
  it("draws every word of 54 once on mount", () => {
    labelled.calls = [];
    render(<ScriptPane {...props()} />);
    expect(labelled.calls).toHaveLength(49);
  });

  it("re-renders only the old and the new playing word on a playhead tick", () => {
    const { rerender } = render(<ScriptPane {...props({ playing: 3 })} />);
    labelled.calls = [];
    rerender(<ScriptPane {...props({ playing: 4 })} />);
    expect(labelled.calls).toEqual(["the", "show."]);
    labelled.calls = [];
    rerender(<ScriptPane {...props({ playing: 22 })} />);
    expect(labelled.calls).toEqual(["show.", "having"]);
    labelled.calls = [];
    rerender(<ScriptPane {...props({ playing: [22, 52] })} />);
    expect(labelled.calls).toEqual(["buy"]);
  });

  it("re-renders only the words whose selection changed", () => {
    const { rerender } = render(
      <ScriptPane
        {...props({ selection: { kind: "words", anchor: 12, head: 13 } })}
      />,
    );
    labelled.calls = [];
    rerender(
      <ScriptPane
        {...props({ selection: { kind: "words", anchor: 12, head: 14 } })}
      />,
    );
    expect(labelled.calls).toEqual(["can"]);
  });

  it("leaves the words alone when the host passes new handlers and the same data", () => {
    const { rerender } = render(<ScriptPane {...props({ playing: 3 })} />);
    labelled.calls = [];
    rerender(<ScriptPane {...props({ playing: 3 })} />);
    expect(labelled.calls).toEqual([]);
  });
});

describe("ScriptPane hallucination marker", () => {
  const TIP = "Possible transcription with no matching speech";
  const flagged = patchWords(SCRIPT_TURNS, { 26: { hallucination: true } });

  it("marks a flagged word with the attribute, the title and the aria note", () => {
    const { container } = render(<ScriptPane {...props({ turns: flagged })} />);
    const marked = container.querySelectorAll("[data-hallucination]");
    expect(marked).toHaveLength(1);
    const word = marked[0] as HTMLElement;
    expect(word).toHaveAttribute("title", TIP);
    expect(word).toHaveAttribute(
      "aria-label",
      `${word.textContent} (possible transcription with no matching speech)`,
    );
    expect(word).not.toHaveAttribute("data-unsure");
    expect(container.querySelectorAll("[title]")).toHaveLength(1);
  });

  it("leaves the unsure count alone when a word is only flagged", () => {
    const unsureOnly = patchWords(SCRIPT_TURNS, {
      10: { lowConfidence: true },
    });
    const both = patchWords(unsureOnly, { 26: { hallucination: true } });
    const label = (turns: ScriptPaneProps["turns"]) => {
      const { container, unmount } = render(
        <ScriptPane {...props({ turns, onNextUnsure: () => {} })} />,
      );
      const tool = container.querySelector(".sys-script-unsure");
      const text = tool?.getAttribute("aria-label") ?? null;
      const shown = tool?.textContent ?? null;
      unmount();
      return { text, shown };
    };
    const base = label(unsureOnly);
    expect(base.text).toBe("1 unsure word, go to the next");
    expect(label(both)).toEqual(base);
    expect(label(flagged)).toEqual({ text: null, shown: null });
  });

  it("keeps the mark on a flagged word that is also selected", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          turns: flagged,
          selection: { kind: "words", anchor: 26, head: 26 },
        })}
      />,
    );
    const word = container.querySelector("[data-hallucination]") as HTMLElement;
    expect(word).toHaveAttribute("data-selected");
    expect(word).toHaveAttribute("title", TIP);
  });

  it("names both notes when a word is also unsure", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, {
            26: { hallucination: true, lowConfidence: true },
          }),
        })}
      />,
    );
    const word = container.querySelector("[data-hallucination]") as HTMLElement;
    expect(word).toHaveAttribute("data-unsure");
    expect(word).toHaveAttribute(
      "aria-label",
      `${word.textContent} (unsure, possible transcription with no matching speech)`,
    );
  });
});

describe("ScriptPane locked marker", () => {
  const LOCK_TIP =
    "Suppression locked: set directly, not by a heuristic pass. Reconcile and auto-suppress leave it alone.";
  const HALLUCINATION_TIP = "Possible transcription with no matching speech";
  const locked = patchWords(SCRIPT_TURNS, { 37: { locked: true } });

  it("marks a locked word with the attribute, the title, the aria note and one glyph", () => {
    const { container } = render(<ScriptPane {...props({ turns: locked })} />);
    const marked = container.querySelectorAll("[data-locked]");
    expect(marked).toHaveLength(1);
    const word = marked[0] as HTMLElement;
    expect(word).toHaveAttribute("title", LOCK_TIP);
    expect(word).toHaveAttribute(
      "aria-label",
      `${word.textContent} (suppression locked)`,
    );
    expect(
      word.querySelectorAll('svg.sys-script-lock[aria-hidden="true"]'),
    ).toHaveLength(1);
    expect(word.textContent).toBe("found");
    expect(container.querySelectorAll("[title]")).toHaveLength(1);
  });

  it("keeps a muted run one run when one of its words is locked", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, {
            ...spanPatch(12, 14, { mark: MUTED }),
            13: { mark: MUTED, locked: true },
          }),
        })}
      />,
    );
    expect(container.querySelectorAll(".sys-script-muted")).toHaveLength(1);
    expect(container.querySelectorAll("[data-locked]")).toHaveLength(1);
    expect(container.querySelectorAll(".sys-script-muted > svg")).toHaveLength(
      1,
    );
    expect(
      container.querySelector("[data-locked]")?.getAttribute("aria-label"),
    ).toMatch(/\(muted, suppression locked\)$/);
  });

  it("gives both tips and both notes to a locked word that is also flagged", () => {
    const { container } = render(
      <ScriptPane
        {...props({
          turns: patchWords(SCRIPT_TURNS, {
            26: { locked: true, hallucination: true },
          }),
        })}
      />,
    );
    const word = container.querySelector("[data-locked]") as HTMLElement;
    expect(word).toHaveAttribute("data-hallucination");
    expect(word).toHaveAttribute("title", `${LOCK_TIP}\n${HALLUCINATION_TIP}`);
    expect(word).toHaveAttribute(
      "aria-label",
      `${word.textContent} (suppression locked, possible transcription with no matching speech)`,
    );
  });

  it("gives an unlocked word no attribute and no glyph", () => {
    const { container } = render(<ScriptPane {...props()} />);
    expect(container.querySelector("[data-locked]")).toBeNull();
    expect(container.querySelector(".sys-script-lock")).toBeNull();
  });
});
