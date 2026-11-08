import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { CombinedUtterance } from "../../../types/project";
import { useScriptModel } from "./useScriptModel";

const original: CombinedUtterance[] = [
  scriptUtterance("host", "Maya", [
    scriptWord("maybe", 4, 5, { unsure: true }),
    scriptWord("perhaps", 5, 5.2, { unsure: true }),
  ]),
];

const afterCut: CombinedUtterance[] = [
  scriptUtterance("host", "Maya", [
    scriptWord("maybe", 4, 5, {
      unsure: true,
      mappable: false,
      timeline_start: null,
      timeline_end: null,
    }),
    scriptWord("perhaps", 5, 5.2, { unsure: true }),
  ]),
];

function replaceUtterances(utterances: CombinedUtterance[]) {
  useDawStore.setState((state) => ({
    project: state.project
      ? {
          ...state.project,
          transcript: { ...state.project.transcript, utterances },
        }
      : null,
  }));
}

beforeEach(() => seedScript({ utterances: original }));

describe("useScriptModel unsure words after a cut", () => {
  it("excludes every repeated rendered ref without changing its window slots", () => {
    const repeated: CombinedUtterance[] = [
      scriptUtterance("host", "Maya", [
        scriptWord("maybe", 4, 5, {
          unsure: true,
          mappable: false,
          timeline_start: null,
          timeline_end: null,
        }),
      ]),
      scriptUtterance("host", "Maya", [
        scriptWord("maybe", 4, 5, {
          unsure: true,
          mappable: false,
          timeline_start: null,
          timeline_end: null,
        }),
      ]),
      scriptUtterance("host", "Maya", [
        scriptWord("perhaps", 5, 5.2, { unsure: true }),
      ]),
    ];
    replaceUtterances(repeated);

    const { result } = renderHook(() => useScriptModel());

    expect(result.current.unsure).toEqual([2]);
    expect(result.current.model.refs).toEqual([
      { trackId: "host", sourceId: null, wordIndex: 4 },
      { trackId: "host", sourceId: null, wordIndex: 4 },
      { trackId: "host", sourceId: null, wordIndex: 5 },
    ]);
    expect(result.current.texts).toEqual(["maybe", "maybe", "perhaps"]);
    expect(
      result.current.model.turns
        .flatMap((turn) => turn.words)
        .map((w) => w.lowConfidence),
    ).toEqual([true, true, true]);
  });

  it("removes only the cut word from the active count and restores it on Undo", () => {
    const { result } = renderHook(() => useScriptModel());
    const wordState = () =>
      result.current.model.refs.map((ref, index) => ({
        ref,
        text: result.current.texts[index],
        lowConfidence: result.current.model.turns.flatMap((turn) => turn.words)[
          index
        ]?.lowConfidence,
      }));
    const originalWords = wordState();

    expect(result.current.unsure).toEqual([0, 1]);
    expect(result.current.model.refs).toEqual([
      { trackId: "host", sourceId: null, wordIndex: 4 },
      { trackId: "host", sourceId: null, wordIndex: 5 },
    ]);

    act(() => replaceUtterances(afterCut));

    expect(result.current.unsure).toEqual([1]);
    expect(result.current.model.refs).toEqual(
      originalWords.map(({ ref }) => ref),
    );
    expect(result.current.texts).toEqual(originalWords.map(({ text }) => text));
    expect(
      result.current.model.turns
        .flatMap((turn) => turn.words)
        .map((w) => w.lowConfidence),
    ).toEqual([true, true]);
    expect(result.current.model.seekSecOf(0)).toBeNull();
    expect(result.current.model.seekSecOf(1)).toBe(5.2);

    act(() => replaceUtterances(original));

    expect(result.current.unsure).toEqual([0, 1]);
    expect(wordState()).toEqual(originalWords);
  });
});
