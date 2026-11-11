import { describe, expect, it } from "vitest";
import type { CombinedUtterance } from "../types/project";
import {
  isLowConfidenceWord,
  type LowConfidenceStop,
  lowConfidenceStops,
  reviewCursorIndex,
  selectLowConfidenceStops,
  stepLowConfidence,
} from "./lowConfidence";

function u(partial: Partial<CombinedUtterance>): CombinedUtterance {
  return {
    track_id: "host",
    speaker: "Host",
    start: 0,
    end: 1,
    text: "",
    mappable: true,
    ...partial,
  };
}

describe("isLowConfidenceWord", () => {
  it("follows the server flag, not the confidence", () => {
    expect(isLowConfidenceWord({ unsure: true })).toBe(true);
    expect(isLowConfidenceWord({ unsure: false })).toBe(false);
    expect(isLowConfidenceWord({})).toBe(false);
  });

  it("never counts a suppressed word", () => {
    expect(isLowConfidenceWord({ unsure: true, suppressed: true })).toBe(false);
    expect(isLowConfidenceWord({ unsure: true, suppressed: false })).toBe(true);
  });
});

describe("lowConfidenceStops", () => {
  const utterances: CombinedUtterance[] = [
    u({
      track_id: "host",
      text: "so um",
      words: [
        { text: "so", start: 0, end: 0.5, word_index: 0, confidence: 0.9 },
        {
          text: "um",
          start: 0.5,
          end: 1,
          word_index: 1,
          confidence: 0.4,
          unsure: true,
          timeline_start: 5,
        },
        { text: "no-index", start: 1, end: 1.5, confidence: 0.1, unsure: true },
      ],
    }),
    u({
      track_id: "guest",
      text: "well",
      mappable: false,
      words: [
        {
          text: "well",
          start: 2,
          end: 2.5,
          word_index: 0,
          confidence: 0.3,
          unsure: true,
          mappable: false,
        },
      ],
    }),
  ];

  it("returns transcript order across utterances/tracks, skipping unindexed or confident words", () => {
    expect(lowConfidenceStops(utterances)).toEqual<LowConfidenceStop[]>([
      { trackId: "host", wordIndex: 1, text: "um", seekSec: 5, order: 1 },
    ]);
  });

  it("skips suppressed-only rows but still numbers their words", () => {
    const utts: CombinedUtterance[] = [
      u({
        track_id: "guest",
        text: "um",
        suppressed_only: true,
        words: [
          {
            text: "um",
            start: 0,
            end: 0.2,
            word_index: 0,
            confidence: 0.3,
            unsure: true,
            suppressed: true,
          },
        ],
      }),
      u({
        track_id: "host",
        text: "so",
        words: [
          {
            text: "so",
            start: 1,
            end: 1.2,
            word_index: 0,
            confidence: 0.4,
            unsure: true,
          },
        ],
      }),
    ];
    expect(lowConfidenceStops(utts)).toEqual<LowConfidenceStop[]>([
      { trackId: "host", wordIndex: 0, text: "so", seekSec: null, order: 1 },
    ]);
  });

  it("skips a suppressed word inside a mixed utterance but keeps its neighbours", () => {
    const utts: CombinedUtterance[] = [
      u({
        track_id: "host",
        text: "so um well",
        words: [
          {
            text: "so",
            start: 0,
            end: 0.2,
            word_index: 0,
            confidence: 0.4,
            unsure: true,
          },
          {
            text: "um",
            start: 0.2,
            end: 0.4,
            word_index: 1,
            confidence: 0.3,
            unsure: true,
            suppressed: true,
          },
          {
            text: "well",
            start: 0.4,
            end: 0.6,
            word_index: 2,
            confidence: 0.4,
            unsure: true,
          },
        ],
      }),
    ];
    expect(lowConfidenceStops(utts).map((s) => [s.text, s.order])).toEqual([
      ["so", 0],
      ["well", 2],
    ]);
  });

  it("skips a cut-away word in a mapped utterance while keeping its unsure neighbor", () => {
    const utterances = [
      u({
        track_id: "host",
        source_id: "source-a",
        words: [
          {
            text: "maybe",
            start: 0,
            end: 0.2,
            word_index: 4,
            unsure: true,
            mappable: false,
            timeline_start: null,
            timeline_end: null,
          },
          {
            text: "perhaps",
            start: 0.2,
            end: 0.4,
            word_index: 5,
            unsure: true,
            mappable: true,
            timeline_start: 8,
            timeline_end: 8.2,
          },
          {
            text: "uncertain-map",
            start: 0.4,
            end: 0.6,
            word_index: 6,
            unsure: true,
          },
        ],
      }),
    ];

    expect(lowConfidenceStops(utterances)).toEqual([
      {
        trackId: "host",
        sourceId: "source-a",
        wordIndex: 5,
        text: "perhaps",
        seekSec: 8,
        endSec: 8.2,
        order: 1,
      },
      {
        trackId: "host",
        sourceId: "source-a",
        wordIndex: 6,
        text: "uncertain-map",
        seekSec: null,
        order: 2,
      },
    ]);
  });

  it("numbers cut-away words too, so order counts every indexed word", () => {
    const utts: CombinedUtterance[] = [
      u({
        track_id: "guest",
        mappable: false,
        words: [
          {
            text: "well",
            start: 0,
            end: 0.5,
            word_index: 0,
            confidence: 0.3,
            unsure: true,
            mappable: false,
          },
        ],
      }),
      u({
        track_id: "host",
        words: [
          { text: "so", start: 1, end: 1.5, word_index: 0, confidence: 0.9 },
          {
            text: "um",
            start: 1.5,
            end: 2,
            word_index: 1,
            confidence: 0.4,
            unsure: true,
            timeline_start: 5,
          },
        ],
      }),
    ];
    expect(lowConfidenceStops(utts)).toEqual<LowConfidenceStop[]>([
      { trackId: "host", wordIndex: 1, text: "um", seekSec: 5, order: 2 },
    ]);
  });
});

describe("selectLowConfidenceStops", () => {
  const utts: CombinedUtterance[] = [
    u({
      track_id: "host",
      text: "so um",
      words: [
        { text: "so", start: 0, end: 0.5, word_index: 0, confidence: 0.9 },
        {
          text: "um",
          start: 0.5,
          end: 1,
          word_index: 1,
          confidence: 0.4,
          unsure: true,
          timeline_start: 5,
        },
      ],
    }),
    u({
      track_id: "guest",
      text: "well",
      mappable: false,
      words: [
        {
          text: "well",
          start: 2,
          end: 2.5,
          word_index: 0,
          confidence: 0.3,
          unsure: true,
          mappable: false,
        },
      ],
    }),
  ];

  it("caches by utterance array identity", () => {
    const a = selectLowConfidenceStops(utts);
    const b = selectLowConfidenceStops(utts);
    expect(b).toBe(a);
    expect(a).toEqual(lowConfidenceStops(utts));

    const c = selectLowConfidenceStops([...utts]);
    expect(c).not.toBe(a);
  });

  it("keeps each utterance array cached while callers alternate", () => {
    const other = [...utts];
    const a = selectLowConfidenceStops(utts);
    const b = selectLowConfidenceStops(other);
    expect(b).not.toBe(a);
    expect(selectLowConfidenceStops(utts)).toBe(a);
    expect(selectLowConfidenceStops(other)).toBe(b);
  });
});

describe("reviewCursorIndex", () => {
  const stops: LowConfidenceStop[] = [
    { trackId: "host", wordIndex: 1, text: "a", seekSec: 1, order: 1 },
    { trackId: "host", wordIndex: 2, text: "b", seekSec: 2, order: 2 },
  ];

  it("is -1 with no cursor", () => {
    expect(reviewCursorIndex(stops, null)).toBe(-1);
  });

  it("finds the matching stop", () => {
    expect(
      reviewCursorIndex(stops, {
        trackId: "host",
        wordIndex: 2,
        order: 2,
      }),
    ).toBe(1);
  });
});

describe("stepLowConfidence", () => {
  const stops3: LowConfidenceStop[] = [
    { trackId: "t", wordIndex: 0, text: "a", seekSec: 0, order: 0 },
    { trackId: "t", wordIndex: 1, text: "b", seekSec: 1, order: 1 },
    { trackId: "t", wordIndex: 2, text: "c", seekSec: 2, order: 2 },
  ];

  it("with no cursor: next goes to the first, prev to the last", () => {
    expect(stepLowConfidence(stops3, null, "next")).toBe(0);
    expect(stepLowConfidence(stops3, null, "prev")).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(
      stepLowConfidence(
        stops3,
        { trackId: "t", wordIndex: 2, order: 2 },
        "next",
      ),
    ).toBe(0);
    expect(
      stepLowConfidence(
        stops3,
        { trackId: "t", wordIndex: 0, order: 0 },
        "prev",
      ),
    ).toBe(2);
  });

  it("resumes by transcript order when the cursor's word left the list", () => {
    const stops2: LowConfidenceStop[] = [
      { trackId: "t", wordIndex: 1, text: "x", seekSec: 1, order: 1 },
      { trackId: "t", wordIndex: 3, text: "y", seekSec: 3, order: 3 },
    ];
    // Cursor's word sat between the two remaining stops: next -> y, prev -> x.
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 2, order: 2 },
        "next",
      ),
    ).toBe(1);
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 2, order: 2 },
        "prev",
      ),
    ).toBe(0);
    // Cursor's word was after both (the end): next wraps to the first, prev to the last.
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 4, order: 4 },
        "next",
      ),
    ).toBe(0);
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 4, order: 4 },
        "prev",
      ),
    ).toBe(1);
    // Cursor's word was before both: next -> the first, prev wraps to the last.
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 0, order: 0 },
        "next",
      ),
    ).toBe(0);
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 0, order: 0 },
        "prev",
      ),
    ).toBe(1);
  });

  it("does not skip a surviving stop when a batch removes several, including the cursor's", () => {
    // Stops B and C were fixed in one batch; cursor was on C (order 2).
    // Next must land on D (order 3), not skip to E (order 4).
    const remaining: LowConfidenceStop[] = [
      { trackId: "t", wordIndex: 0, text: "a", seekSec: 0, order: 0 },
      { trackId: "t", wordIndex: 3, text: "d", seekSec: 3, order: 3 },
      { trackId: "t", wordIndex: 4, text: "e", seekSec: 4, order: 4 },
    ];
    const cursor = { trackId: "t", wordIndex: 2, order: 2 };
    expect(stepLowConfidence(remaining, cursor, "next")).toBe(1);
    expect(stepLowConfidence(remaining, cursor, "prev")).toBe(0);
  });

  it("is -1 with no stops", () => {
    expect(stepLowConfidence([], null, "next")).toBe(-1);
  });
});
