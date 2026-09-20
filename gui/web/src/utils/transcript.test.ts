import { describe, expect, it } from "vitest";
import type { CombinedUtterance } from "../types/project";
import {
  centeredScrollTop,
  findActiveUtteranceIndex,
  groupConsecutiveSpeakerTurns,
  isUtteranceActive,
  isWordActive,
  selectUnmappedUtterances,
  turnSeekSec,
  utteranceSeekSec,
  utteranceTimelineEnd,
  utteranceTimelineSpans,
  utteranceTimelineStart,
  wordSeekSec,
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
