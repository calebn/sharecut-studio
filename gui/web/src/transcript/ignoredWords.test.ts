import { describe, expect, it } from "vitest";
import type {
  ProjectView,
  Selection,
  TranscriptWordView,
} from "../types/project";
import { ignoredRuns, ignoreTarget, selectionAllIgnored } from "./ignoredWords";

function words(spec: Array<[number, boolean]>): TranscriptWordView[] {
  return spec.map(([word_index, ignored]) => ({
    text: `w${word_index}`,
    start: word_index,
    end: word_index + 0.5,
    word_index,
    ignored,
  }));
}

function projectWithWords(
  trackId: string,
  wordList: TranscriptWordView[],
): ProjectView {
  return {
    transcript: {
      utterances: [
        {
          track_id: trackId,
          speaker: "Host",
          start: 0,
          end: 10,
          text: "text",
          words: wordList,
        },
      ],
    },
  } as unknown as ProjectView;
}

describe("ignoredRuns", () => {
  it("groups consecutive ignored word_index values", () => {
    const runs = ignoredRuns(
      "host",
      words([
        [0, false],
        [1, true],
        [2, true],
        [3, false],
        [4, true],
      ]),
    );
    expect(runs).toEqual([
      { trackId: "host", startWordIndex: 1, endWordIndex: 2 },
      { trackId: "host", startWordIndex: 4, endWordIndex: 4 },
    ]);
  });

  it("returns an empty array when nothing is ignored", () => {
    expect(
      ignoredRuns(
        "host",
        words([
          [0, false],
          [1, false],
        ]),
      ),
    ).toEqual([]);
  });

  it("closes a run that runs to the end of the words", () => {
    const runs = ignoredRuns(
      "host",
      words([
        [0, true],
        [1, true],
      ]),
    );
    expect(runs).toEqual([
      { trackId: "host", startWordIndex: 0, endWordIndex: 1 },
    ]);
  });
});

describe("selectionAllIgnored", () => {
  it("is true only when every word in the range is ignored", () => {
    const project = projectWithWords(
      "host",
      words([
        [0, true],
        [1, true],
        [2, false],
      ]),
    );
    expect(selectionAllIgnored(project, "host", 0, 1)).toBe(true);
    expect(selectionAllIgnored(project, "host", 0, 2)).toBe(false);
  });

  it("is false when no word is found in the range", () => {
    const project = projectWithWords("host", words([[0, true]]));
    expect(selectionAllIgnored(project, "host", 5, 6)).toBe(false);
  });
});

describe("ignoreTarget", () => {
  it("uses explicit args over the selection", () => {
    const target = ignoreTarget(null, null, {
      trackId: "host",
      startWordIndex: 2,
      endWordIndex: 4,
      ignored: true,
    });
    expect(target).toEqual({
      trackId: "host",
      startWordIndex: 2,
      endWordIndex: 4,
      ignored: true,
    });
  });

  it("toggles to ignore when the selection range is not fully ignored", () => {
    const project = projectWithWords(
      "host",
      words([
        [0, false],
        [1, true],
      ]),
    );
    const selection: Selection = {
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 1,
    };
    const target = ignoreTarget(project, selection, {});
    expect(target).toEqual({
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 1,
      ignored: true,
    });
  });

  it("toggles to restore when the selection range is fully ignored", () => {
    const project = projectWithWords(
      "host",
      words([
        [0, true],
        [1, true],
      ]),
    );
    const selection: Selection = {
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 1,
    };
    const target = ignoreTarget(project, selection, {});
    expect(target?.ignored).toBe(false);
  });

  it("resolves a transcriptWord selection to a single-word range", () => {
    const selection: Selection = {
      kind: "transcriptWord",
      trackId: "host",
      wordIndex: 3,
    };
    const target = ignoreTarget(null, selection, { ignored: true });
    expect(target).toEqual({
      trackId: "host",
      startWordIndex: 3,
      endWordIndex: 3,
      ignored: true,
    });
  });

  it("returns null with no track or no selection", () => {
    expect(ignoreTarget(null, null, {})).toBeNull();
    expect(
      ignoreTarget(null, { kind: "clip", id: "c1", trackId: "host" }, {}),
    ).toBeNull();
  });
});
