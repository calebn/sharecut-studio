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
