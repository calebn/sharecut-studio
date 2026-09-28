import { describe, expect, it } from "vitest";
import type { CombinedUtterance } from "../types/project";
import {
  isLowConfidenceWord,
  type LowConfidenceStop,
  lowConfidenceStops,
  reviewCursorIndex,
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
  it("treats null or undefined confidence as not flagged", () => {
    expect(isLowConfidenceWord({ confidence: null })).toBe(false);
    expect(isLowConfidenceWord({ confidence: undefined })).toBe(false);
  });

  it("flags below 0.7 and not at 0.7", () => {
    expect(isLowConfidenceWord({ confidence: 0.69 })).toBe(true);
    expect(isLowConfidenceWord({ confidence: 0.7 })).toBe(false);
  });
});

describe("lowConfidenceStops", () => {
  it("returns transcript order across utterances/tracks, skipping unindexed or confident words", () => {
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
            timeline_start: 5,
          },
          { text: "no-index", start: 1, end: 1.5, confidence: 0.1 },
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
            mappable: false,
          },
        ],
      }),
    ];
    expect(lowConfidenceStops(utterances)).toEqual<LowConfidenceStop[]>([
      { trackId: "host", wordIndex: 1, text: "um", seekSec: 5 },
      { trackId: "guest", wordIndex: 0, text: "well", seekSec: null },
    ]);
  });
});

describe("reviewCursorIndex", () => {
  const stops: LowConfidenceStop[] = [
    { trackId: "host", wordIndex: 1, text: "a", seekSec: 1 },
    { trackId: "host", wordIndex: 2, text: "b", seekSec: 2 },
  ];

  it("is -1 with no cursor", () => {
    expect(reviewCursorIndex(stops, null)).toBe(-1);
  });

  it("finds the matching stop", () => {
    expect(
      reviewCursorIndex(stops, {
        trackId: "host",
        wordIndex: 2,
        position: 0,
      }),
    ).toBe(1);
  });
});

describe("stepLowConfidence", () => {
  const stops3: LowConfidenceStop[] = [
    { trackId: "t", wordIndex: 0, text: "a", seekSec: 0 },
    { trackId: "t", wordIndex: 1, text: "b", seekSec: 1 },
    { trackId: "t", wordIndex: 2, text: "c", seekSec: 2 },
  ];

  it("with no cursor: next goes to the first, prev to the last", () => {
    expect(stepLowConfidence(stops3, null, "next")).toBe(0);
    expect(stepLowConfidence(stops3, null, "prev")).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(
      stepLowConfidence(
        stops3,
        { trackId: "t", wordIndex: 2, position: 2 },
        "next",
      ),
    ).toBe(0);
    expect(
      stepLowConfidence(
        stops3,
        { trackId: "t", wordIndex: 0, position: 0 },
        "prev",
      ),
    ).toBe(2);
  });

  it("steps from the stored slot when the cursor's word left the list", () => {
    const stops2: LowConfidenceStop[] = [
      { trackId: "t", wordIndex: 5, text: "x", seekSec: 5 },
      { trackId: "t", wordIndex: 6, text: "y", seekSec: 6 },
    ];
    // Word that was at position 1 got corrected; next steps into slot 1, prev into slot 0.
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 999, position: 1 },
        "next",
      ),
    ).toBe(1);
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 999, position: 1 },
        "prev",
      ),
    ).toBe(0);
    // Word that was at position 2 (the end) wraps: next -> 0, prev -> the last (1).
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 999, position: 2 },
        "next",
      ),
    ).toBe(0);
    expect(
      stepLowConfidence(
        stops2,
        { trackId: "t", wordIndex: 999, position: 2 },
        "prev",
      ),
    ).toBe(1);
  });

  it("is -1 with no stops", () => {
    expect(stepLowConfidence([], null, "next")).toBe(-1);
  });
});
