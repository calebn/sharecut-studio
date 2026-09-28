import { describe, expect, it } from "vitest";
import { presenceAnchor } from "../presence/anchors";
import type {
  CombinedUtterance,
  ProjectView,
  TranscriptWordView,
} from "../types/project";
import {
  centeredScrollTop,
  findActiveUtteranceIndex,
  findTranscriptWord,
  findTranscriptWordIn,
  findTurnIndexForUtterance,
  groupConsecutiveSpeakerTurns,
  isTranscriptUtteranceVisible,
  isUtteranceActive,
  isWordActive,
  selectUnmappedUtterances,
  transcriptAnchorTurnIndex,
  transcriptSpanText,
  transcriptWordAnchor,
  transcriptWordRange,
  turnKey,
  turnSeekSec,
  utteranceSeekSec,
  utteranceTimelineEnd,
  utteranceTimelineSpans,
  utteranceTimelineStart,
  visibleTranscriptUtterances,
  wordSeekSec,
  wordsForUtterance,
} from "./transcript";

function u(
  partial: Partial<CombinedUtterance> &
    Pick<CombinedUtterance, "start" | "end" | "text">,
): CombinedUtterance {
  return {
    track_id: "host",
    speaker: "Host",
    mappable: true,
    ...partial,
  };
}

describe("utterance timeline helpers", () => {
  it("prefers mapped timeline clocks", () => {
    const row = u({
      start: 10,
      end: 20,
      timeline_start: 5,
      timeline_end: 12,
      text: "hi",
    });
    expect(utteranceTimelineStart(row)).toBe(5);
    expect(utteranceTimelineEnd(row)).toBe(12);
  });

  it("returns null for unmapped (no source fallback)", () => {
    const row = u({
      start: 10,
      end: 20,
      mappable: false,
      timeline_start: null,
      timeline_end: null,
      text: "gone",
    });
    expect(utteranceTimelineStart(row)).toBeNull();
    expect(utteranceTimelineEnd(row)).toBeNull();
    expect(utteranceSeekSec(row)).toBeNull();
    expect(utteranceTimelineSpans(row)).toEqual([]);
    expect(isUtteranceActive(row, 10)).toBe(false);
    expect(isUtteranceActive(row, 15)).toBe(false);
  });

  it("exposes multi-span intervals", () => {
    const row = u({
      start: 0,
      end: 20,
      timeline_start: 0,
      timeline_end: 12,
      timeline_spans: [
        { start: 0, end: 4 },
        { start: 8, end: 12 },
      ],
      text: "split",
    });
    expect(utteranceTimelineSpans(row)).toEqual([
      { start: 0, end: 4 },
      { start: 8, end: 12 },
    ]);
    expect(utteranceTimelineStart(row)).toBe(0);
    expect(utteranceTimelineEnd(row)).toBe(12);
    expect(utteranceSeekSec(row)).toBe(0);
  });
});

describe("isUtteranceActive / findActiveUtteranceIndex", () => {
  const rows = [
    u({ start: 0, end: 5, timeline_start: 0, timeline_end: 5, text: "a" }),
    u({ start: 5, end: 10, timeline_start: 5, timeline_end: 10, text: "b" }),
    u({ start: 10, end: 15, timeline_start: 10, timeline_end: 15, text: "c" }),
  ];

  it("marks half-open interval as active", () => {
    expect(isUtteranceActive(rows[1], 5)).toBe(true);
    expect(isUtteranceActive(rows[1], 9.99)).toBe(true);
    expect(isUtteranceActive(rows[1], 10)).toBe(false);
  });

  it("finds the covering index", () => {
    expect(findActiveUtteranceIndex(rows, 0)).toBe(0);
    expect(findActiveUtteranceIndex(rows, 7.5)).toBe(1);
    expect(findActiveUtteranceIndex(rows, 14)).toBe(2);
    expect(findActiveUtteranceIndex(rows, 20)).toBe(-1);
  });

  it("is inactive in gaps between multi-span intervals", () => {
    const split = u({
      start: 0,
      end: 20,
      timeline_start: 0,
      timeline_end: 12,
      timeline_spans: [
        { start: 0, end: 4 },
        { start: 8, end: 12 },
      ],
      text: "split",
    });
    expect(isUtteranceActive(split, 2)).toBe(true);
    expect(isUtteranceActive(split, 4)).toBe(false);
    expect(isUtteranceActive(split, 6)).toBe(false);
    expect(isUtteranceActive(split, 8)).toBe(true);
    expect(findActiveUtteranceIndex([split], 6)).toBe(-1);
  });

  it("never activates unmapped rows", () => {
    const gone = u({
      start: 0,
      end: 100,
      mappable: false,
      text: "cut",
    });
    expect(findActiveUtteranceIndex([gone, ...rows], 7.5)).toBe(2);
  });
});

describe("selectUnmappedUtterances", () => {
  it("filters mappable === false", () => {
    const mapped = u({ start: 0, end: 1, text: "ok" });
    const cut = u({ start: 2, end: 3, mappable: false, text: "cut" });
    expect(selectUnmappedUtterances([mapped, cut])).toEqual([cut]);
  });
});

describe("centeredScrollTop", () => {
  it("centers a mid-list child in the viewport", () => {
    // viewport 200, content 1000, child at 400..440 → center 420 → scroll 320
    expect(centeredScrollTop(200, 1000, 400, 40, 0.5)).toBe(320);
  });

  it("clamps to the top and bottom of the scroll range", () => {
    expect(centeredScrollTop(200, 1000, 10, 20, 0.5)).toBe(0);
    expect(centeredScrollTop(200, 1000, 950, 40, 0.5)).toBe(800);
  });
});

describe("groupConsecutiveSpeakerTurns", () => {
  it("merges consecutive same-speaker fragments", () => {
    const rows = [
      u({ start: 0, end: 1, text: "of", speaker: "Olga", track_id: "olga" }),
      u({
        start: 2,
        end: 3,
        text: "don't know",
        speaker: "Olga",
        track_id: "olga",
      }),
      u({ start: 4, end: 5, text: "my", speaker: "Olga", track_id: "olga" }),
      u({
        start: 6,
        end: 7,
        text: "So yeah",
        speaker: "Vicky",
        track_id: "vicky",
      }),
    ];
    const turns = groupConsecutiveSpeakerTurns(rows);
    expect(turns).toHaveLength(2);
    expect(turns[0].utterances.map((x) => x.text)).toEqual([
      "of",
      "don't know",
      "my",
    ]);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[0].endIndex).toBe(2);
    expect(turns[1].speaker).toBe("Vicky");
  });

  it("splits when track changes even if speaker label matches", () => {
    const turns = groupConsecutiveSpeakerTurns([
      u({ start: 0, end: 1, text: "a", speaker: "Host", track_id: "a" }),
      u({ start: 1, end: 2, text: "b", speaker: "Host", track_id: "b" }),
    ]);
    expect(turns).toHaveLength(2);
  });

  it("turnSeekSec uses the first mapped utterance", () => {
    const turns = groupConsecutiveSpeakerTurns([
      u({
        start: 0,
        end: 1,
        text: "gone",
        mappable: false,
        timeline_start: null,
        timeline_end: null,
      }),
      u({
        start: 2,
        end: 3,
        text: "hi",
        timeline_start: 10,
        timeline_end: 11,
      }),
    ]);
    expect(turnSeekSec(turns[0])).toBe(10);
  });
});

describe("word seek helpers", () => {
  it("wordSeekSec ignores unmapped words", () => {
    expect(
      wordSeekSec({
        text: "hi",
        start: 1,
        end: 2,
        timeline_start: 5,
        mappable: true,
      }),
    ).toBe(5);
    expect(
      wordSeekSec({
        text: "x",
        start: 1,
        end: 2,
        timeline_start: 5,
        mappable: false,
      }),
    ).toBeNull();
  });

  it("isWordActive uses half-open timeline span", () => {
    const w = {
      text: "hi",
      start: 1,
      end: 2,
      timeline_start: 5,
      timeline_end: 7,
      mappable: true,
    };
    expect(isWordActive(w, 5)).toBe(true);
    expect(isWordActive(w, 6.9)).toBe(true);
    expect(isWordActive(w, 7)).toBe(false);
  });
});

describe("turn identity and lookup", () => {
  const rows = [
    u({ start: 0, end: 1, text: "a", speaker: "A", track_id: "a" }),
    u({ start: 1, end: 2, text: "b", speaker: "A", track_id: "a" }),
    u({
      start: 2,
      end: 3,
      text: "c",
      speaker: "B",
      track_id: "b",
      mappable: false,
    }),
    u({ start: 3, end: 4, text: "d", speaker: "A", track_id: "a" }),
  ];

  it("keys turns independently of the visible-row filter", () => {
    const all = groupConsecutiveSpeakerTurns(rows);
    const mapped = groupConsecutiveSpeakerTurns(
      rows.filter((r) => r.mappable !== false),
    );
    expect(turnKey(all[0]!)).toBe(turnKey(mapped[0]!));
    // Hiding the cut-away row shifts startIndex but not the first turn's key.
    expect(all[0]!.startIndex).toBe(mapped[0]!.startIndex);
    expect(new Set(all.map(turnKey)).size).toBe(all.length);
    expect(turnKey({ ...all[0]!, utterances: [] })).toBe("a:empty");
  });

  it("finds the turn for a flat utterance index via start/end", () => {
    const turns = groupConsecutiveSpeakerTurns(rows);
    expect(findTurnIndexForUtterance(turns, 0)).toBe(0);
    expect(findTurnIndexForUtterance(turns, 1)).toBe(0);
    expect(findTurnIndexForUtterance(turns, 2)).toBe(1);
    expect(findTurnIndexForUtterance(turns, 3)).toBe(2);
    expect(findTurnIndexForUtterance(turns, -1)).toBe(-1);
    expect(findTurnIndexForUtterance(turns, 9)).toBe(-1);
  });

  it("falls back to one synthetic word when timings are missing", () => {
    const row = u({ start: 1, end: 2, text: "whole" });
    expect(wordsForUtterance(row)).toEqual([
      expect.objectContaining({ text: "whole", start: 1, end: 2 }),
    ]);
  });

  it("resolves turn and word anchors to their turn without parsing", () => {
    const withWords = u({
      start: 5,
      end: 6,
      text: "x",
      speaker: "C",
      track_id: "Host Room",
      words: [{ text: "x", start: 5, end: 6, word_index: 12 }],
    });
    const turns = groupConsecutiveSpeakerTurns([...rows, withWords]);
    expect(
      transcriptAnchorTurnIndex(
        turns,
        presenceAnchor("transcript", "word", "Host Room", 12),
      ),
    ).toBe(3);
    expect(
      transcriptAnchorTurnIndex(
        turns,
        transcriptWordAnchor(2, "a", undefined, 0),
      ),
    ).toBe(2);
    expect(
      transcriptAnchorTurnIndex(turns, presenceAnchor("transcript", "turn", 1)),
    ).toBe(1);
    expect(transcriptAnchorTurnIndex(turns, "transcript:turn:9999")).toBe(-1);
    expect(transcriptAnchorTurnIndex(turns, "track:a")).toBe(-1);
  });

  it("matches truncated anchors for long track ids", () => {
    const longTrack = "t".repeat(120);
    const turns = groupConsecutiveSpeakerTurns([
      u({ start: 0, end: 1, text: "a", speaker: "A" }),
      u({
        start: 1,
        end: 2,
        text: "b",
        speaker: "B",
        track_id: longTrack,
        words: [{ text: "b", start: 1, end: 2, word_index: 12 }],
      }),
    ]);
    const anchor = presenceAnchor("transcript", "word", longTrack, 12);
    expect(anchor).toHaveLength(96);
    expect(transcriptAnchorTurnIndex(turns, anchor)).toBe(1);
  });
});

describe("indexed transcript word lookup", () => {
  const project = {
    transcript: {
      utterances: [
        u({
          text: "first two",
          start: 0,
          end: 9,
          words: [
            {
              text: "first",
              word_index: 2,
              start: 10,
              end: 11,
              timeline_start: 1,
              timeline_end: 2,
            },
            { text: "two", word_index: 3, start: 12, end: 13 },
          ],
        }),
        u({
          track_id: "guest",
          text: "ignore",
          start: 0,
          end: 9,
          words: [{ text: "ignore", word_index: 4, start: 0, end: 99 }],
        }),
        u({
          text: "last",
          start: 0,
          end: 9,
          words: [
            {
              text: "last",
              word_index: 4,
              start: 14,
              end: 15,
              timeline_start: 4,
              timeline_end: 5,
            },
          ],
        }),
      ],
    },
  } as ProjectView;

  it("finds the first exact word on its track", () => {
    expect(findTranscriptWord(project, "host", 2)?.text).toBe("first");
    expect(findTranscriptWord(project, "host", 99)).toBeNull();
    expect(findTranscriptWord(null, "host", 2)).toBeNull();
  });

  it("finds a word among bare utterances", () => {
    const utterances = project.transcript?.utterances ?? [];
    expect(findTranscriptWordIn(utterances, "host", 2)?.text).toBe("first");
    expect(findTranscriptWordIn(utterances, "host", 99)).toBeNull();
    expect(findTranscriptWordIn([], "host", 2)).toBeNull();
  });

  it("combines reversed indexed ranges across utterances using timeline fallback", () => {
    expect(transcriptWordRange(project, "host", 4, 2)).toEqual({
      start: 1,
      end: 13,
      text: "first two last",
    });
    expect(transcriptWordRange(project, "guest", 4, 4)?.text).toBe("ignore");
    expect(transcriptWordRange(project, "host", 50, 51)).toBeNull();
  });

  it("gets bounds without reading transcript text", () => {
    const word = {
      word_index: 0,
      start: 7,
      end: 7,
    } as TranscriptWordView;
    Object.defineProperty(word, "text", {
      get: () => {
        throw new Error("bounds-only lookup read word text");
      },
    });
    const point = {
      transcript: {
        utterances: [u({ text: "point", start: 7, end: 7, words: [word] })],
      },
    } as ProjectView;
    expect(
      transcriptWordRange(point, "host", 0, 0, { boundsOnly: true }),
    ).toEqual({
      start: 7,
      end: 7,
    });
  });

  it("keeps zero-length word spans available for remote point selections", () => {
    const point = {
      transcript: {
        utterances: [
          u({
            text: "point",
            start: 7,
            end: 7,
            words: [{ text: "point", word_index: 0, start: 7, end: 7 }],
          }),
        ],
      },
    } as ProjectView;
    expect(transcriptWordRange(point, "host", 0, 0)).toEqual({
      start: 7,
      end: 7,
      text: "point",
    });
  });

  it("lists a word duplicated across utterances once in the range text", () => {
    const dup = {
      transcript: {
        utterances: [
          u({
            text: "the quick",
            start: 0,
            end: 2,
            words: [
              { text: "the", word_index: 0, start: 0, end: 1 },
              { text: "quick", word_index: 1, start: 1, end: 2 },
            ],
          }),
          u({
            text: "quick fox",
            start: 1,
            end: 3,
            words: [
              { text: "quick", word_index: 1, start: 1, end: 2 },
              { text: "fox", word_index: 2, start: 2, end: 3 },
            ],
          }),
        ],
      },
    } as ProjectView;
    expect(transcriptWordRange(dup, "host", 0, 2)?.text).toBe("the quick fox");
  });

  it("keeps the first listing of a disagreeing duplicate in the range text", () => {
    const dup = {
      transcript: {
        utterances: [
          u({
            text: "the quick",
            start: 0,
            end: 2,
            words: [
              { text: "the", word_index: 0, start: 0, end: 1 },
              { text: "quick", word_index: 1, start: 1, end: 2 },
            ],
          }),
          u({
            text: "quack fox",
            start: 1,
            end: 3,
            words: [
              { text: "quack", word_index: 1, start: 1, end: 2 },
              { text: "fox", word_index: 2, start: 2, end: 3 },
            ],
          }),
        ],
      },
    } as ProjectView;
    expect(transcriptWordRange(dup, "host", 0, 2)).toEqual({
      start: 0,
      end: 3,
      text: "the quick fox",
    });
  });
});

describe("transcriptSpanText", () => {
  const project = {
    transcript: {
      utterances: [
        u({
          text: "the quick",
          start: 0,
          end: 9,
          words: [
            { text: "the", word_index: 0, start: 0, end: 1 },
            { text: "quick", word_index: 1, start: 1, end: 2 },
          ],
        }),
        u({
          track_id: "guest",
          text: "ignore",
          start: 0,
          end: 9,
          words: [{ text: "ignore", word_index: 2, start: 0, end: 9 }],
        }),
        u({
          text: "quick fox",
          start: 1,
          end: 3,
          words: [
            { text: "quick", word_index: 1, start: 1, end: 2 },
            { text: "fox", word_index: 2, start: 2, end: 3 },
          ],
        }),
      ],
    },
  } as ProjectView;

  it("returns a single word's text", () => {
    expect(transcriptSpanText(project, "host", 0, 0)).toBe("the");
  });

  it("joins a span across two utterances", () => {
    expect(transcriptSpanText(project, "host", 0, 2)).toBe("the quick fox");
  });

  it("counts a word duplicated across utterances once", () => {
    expect(transcriptSpanText(project, "host", 1, 1)).toBe("quick");
  });

  it("returns null when a duplicated index disagrees", () => {
    const dup = {
      transcript: {
        utterances: [
          u({
            text: "a",
            start: 0,
            end: 1,
            words: [{ text: "first", word_index: 0, start: 0, end: 1 }],
          }),
          u({
            text: "b",
            start: 0,
            end: 1,
            words: [{ text: "second", word_index: 0, start: 0, end: 1 }],
          }),
        ],
      },
    } as ProjectView;
    expect(transcriptSpanText(dup, "host", 0, 0)).toBeNull();
  });

  it("returns null when an index in the range is missing", () => {
    const gap = {
      transcript: {
        utterances: [
          u({
            text: "the fox",
            start: 0,
            end: 9,
            words: [
              { text: "the", word_index: 0, start: 0, end: 1 },
              { text: "fox", word_index: 2, start: 2, end: 3 },
            ],
          }),
        ],
      },
    } as ProjectView;
    expect(transcriptSpanText(gap, "host", 0, 2)).toBeNull();
  });

  it("returns null for an invalid range", () => {
    expect(transcriptSpanText(project, "host", 2, 0)).toBeNull();
    expect(transcriptSpanText(project, "host", Number.NaN, 0)).toBeNull();
  });

  it("ignores words on another track", () => {
    expect(transcriptSpanText(project, "guest", 0, 0)).toBeNull();
  });
});

describe("isTranscriptUtteranceVisible", () => {
  const mapped = u({ start: 0, end: 1, text: "hi", mappable: true });
  const cutAway = u({ start: 1, end: 2, text: "bye", mappable: false });

  it("shows a cut-away utterance only under annotate + showCutAway", () => {
    expect(isTranscriptUtteranceVisible(cutAway, true, true)).toBe(true);
    expect(isTranscriptUtteranceVisible(cutAway, true, false)).toBe(false);
    expect(isTranscriptUtteranceVisible(cutAway, false, true)).toBe(false);
    expect(isTranscriptUtteranceVisible(cutAway, false, false)).toBe(false);
  });

  it("always shows a mappable utterance", () => {
    expect(isTranscriptUtteranceVisible(mapped, true, true)).toBe(true);
    expect(isTranscriptUtteranceVisible(mapped, true, false)).toBe(true);
    expect(isTranscriptUtteranceVisible(mapped, false, true)).toBe(true);
    expect(isTranscriptUtteranceVisible(mapped, false, false)).toBe(true);
  });
});

describe("visibleTranscriptUtterances", () => {
  const mapped = u({ start: 0, end: 1, text: "hi", mappable: true });
  const cutAway = u({ start: 1, end: 2, text: "bye", mappable: false });
  const utterances = [mapped, cutAway];

  it("keeps cut-away utterances only when annotate and showCutAway are both on", () => {
    expect(visibleTranscriptUtterances(utterances, true, true)).toEqual(
      utterances,
    );
    expect(visibleTranscriptUtterances(utterances, true, false)).toEqual([
      mapped,
    ]);
    expect(visibleTranscriptUtterances(utterances, false, true)).toEqual([
      mapped,
    ]);
    expect(visibleTranscriptUtterances(utterances, false, false)).toEqual([
      mapped,
    ]);
  });

  it("returns the same array reference when both are on", () => {
    expect(visibleTranscriptUtterances(utterances, true, true)).toBe(
      utterances,
    );
  });
});
