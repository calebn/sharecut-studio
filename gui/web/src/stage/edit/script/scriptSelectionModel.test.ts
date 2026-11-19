import { describe, expect, it } from "vitest";
import type {
  CombinedUtterance,
  EditBoundaryView,
  TranscriptWordView,
} from "../../../types/project";
import { buildScriptModel } from "./scriptModel";
import { selectionModelOf } from "./scriptSelectionModel";

function word(
  text: string,
  wordIndex: number,
  start: number,
  extra: Partial<TranscriptWordView> = {},
): TranscriptWordView {
  return {
    text,
    word_index: wordIndex,
    start,
    end: start + 0.4,
    timeline_start: start + 10,
    timeline_end: start + 10.4,
    mappable: true,
    ...extra,
  };
}

function modelOf(
  words: TranscriptWordView[],
  boundaries: EditBoundaryView[] = [],
) {
  const utterance: CombinedUtterance = {
    track_id: "host",
    source_id: null,
    speaker: "Maya",
    start: 0,
    end: 5,
    text: words.map((w) => w.text).join(" "),
    timeline_start: 10,
    timeline_end: 15,
    mappable: true,
    words,
  };
  return buildScriptModel({
    utterances: [utterance],
    boundaries,
    pending: [],
    person: () => ({ name: "Maya", colorIndex: 0 }),
  });
}

const CUT_BOUNDARY: EditBoundaryView = {
  id: "b1",
  track_id: "host",
  left_clip_id: "c1",
  right_clip_id: "c2",
  timeline_join_sec: 10.5,
  has_cutaway: true,
  cutaway_source_start: 0.5,
  cutaway_source_end: 1,
  cutaway_word_ids: [
    {
      track_id: "host",
      source_id: null,
      word_index: 1,
      text: "gone",
      start: 0.5,
      end: 0.9,
    },
  ],
};

describe("the Script model as the selection follower sees it", () => {
  it("carries each word's text, source start and timeline place", () => {
    const view = selectionModelOf(
      modelOf([word("one", 0, 0), word("two", 1, 0.5)]),
    );
    expect(view.words).toEqual([
      { start: 0, text: "one" },
      { start: 0.5, text: "two" },
    ]);
    expect(view.times).toEqual([
      { start: 10, end: 10.4 },
      { start: 10.5, end: 10.9 },
    ]);
    expect(view.wordStarts).toEqual([10, 10.5]);
    expect(view.cut).toEqual([false, false]);
  });

  it("counts a word with no timeline place as cut, so the host never waits on it", () => {
    const view = selectionModelOf(
      modelOf([
        word("one", 0, 0),
        word("lost", 1, 0.5, { mappable: false }),
        word("two", 2, 1),
      ]),
    );
    expect(view.wordStarts).toEqual([10, null, 11]);
    expect(view.cut).toEqual([false, true, false]);
  });

  it("counts a word an applied cut took out as cut, with no place", () => {
    const view = selectionModelOf(
      modelOf([word("one", 0, 0), word("two", 2, 1)], [CUT_BOUNDARY]),
    );
    const at = view.words.findIndex((w) => w.text === "gone");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(view.cut![at]).toBe(true);
    expect(view.times[at]).toBeNull();
    expect(view.words[at]).toEqual({ start: 0.5, text: "gone" });
  });
});
