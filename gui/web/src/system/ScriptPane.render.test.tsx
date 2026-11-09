import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScriptPaneProps } from "./ScriptPane";
import { ScriptPane } from "./ScriptPane";
import {
  CUT,
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
