import { describe, expect, it } from "vitest";
import type { CombinedUtterance } from "../types/project";
import {
  findActiveUtteranceIndex,
  INSTANT_WORD_SEC,
  isUtteranceActive,
  isWordActive,
  wordsForUtterance,
} from "../utils/transcript";
import {
  activeWordId,
  buildTranscriptActiveIndex,
  parseTranscriptActiveKey,
  transcriptActiveKey,
} from "./transcriptActive";

function utt(
  start: number,
  end: number,
  words: [number, number | null][],
  extra: Partial<CombinedUtterance> = {},
): CombinedUtterance {
  return {
    track_id: "host",
    speaker: "Host",
    start,
    end,
    text: words.map((_, i) => `w${i}`).join(" "),
    timeline_start: start,
    timeline_end: end,
    words: words.map(([s, e], i) => ({
      text: `w${i}`,
      start: s,
      end: e ?? s,
      timeline_start: s,
      timeline_end: e,
    })),
    ...extra,
  };
}

const utterances = [
  utt(0, 2, [
    [0, 1],
    [1, 2],
  ]),
  // Overlaps the first (two speakers), with a zero-length word at 1.5.
  utt(1, 3, [
    [1, 1.4],
    [1.5, null],
    [2, 3],
  ]),
  utt(5, 6, [[5, 6]], { mappable: false }),
];

describe("transcriptActiveKey", () => {
  it.each([0, 0.5, 1, 1.2, 1.46, 1.5, 1.54, 1.99, 2, 2.5, 3, 4, 5.5])(
    "matches isUtteranceActive / isWordActive at %s s",
    (sec) => {
      const index = buildTranscriptActiveIndex(utterances);
      const active = parseTranscriptActiveKey(transcriptActiveKey(index, sec));
      utterances.forEach((u, i) => {
        expect(active.utterances.has(i)).toBe(isUtteranceActive(u, sec));
        wordsForUtterance(u).forEach((w, wi) => {
          expect(active.words.has(activeWordId(i, wi))).toBe(
            isWordActive(w, sec),
          );
        });
      });
      expect(active.first).toBe(findActiveUtteranceIndex(utterances, sec));
    },
  );

  it("prefilters zero-length words with the shared instant-word window", () => {
    const lone = [utt(9, 11, [[10, null]])];
    const index = buildTranscriptActiveIndex(lone);
    const has = (sec: number) =>
      parseTranscriptActiveKey(transcriptActiveKey(index, sec)).words.has(
        activeWordId(0, 0),
      );
    expect(has(10 - INSTANT_WORD_SEC * 0.9)).toBe(true);
    expect(has(10 + INSTANT_WORD_SEC * 0.9)).toBe(true);
    expect(has(10 + INSTANT_WORD_SEC * 1.1)).toBe(false);
  });

  it("is equal across ticks that change nothing", () => {
    const index = buildTranscriptActiveIndex(utterances);
    expect(transcriptActiveKey(index, 0.2)).toBe(
      transcriptActiveKey(index, 0.7),
    );
    expect(transcriptActiveKey(index, 0.7)).not.toBe(
      transcriptActiveKey(index, 1.2),
    );
  });

  it("parses an empty highlight", () => {
    const active = parseTranscriptActiveKey("|");
    expect(active.first).toBe(-1);
    expect(active.utterances.size).toBe(0);
    expect(active.words.size).toBe(0);
  });

  it("skips suppressed-only rows", () => {
    const rows = [utt(0, 2, [[0, 1]], { suppressed_only: true })];
    const index = buildTranscriptActiveIndex(rows);
    expect(transcriptActiveKey(index, 0.5)).toBe("|");
  });
});

describe("indexed transcript highlights", () => {
  it("keeps transcript order for unsorted overlapping rows and backward seeks", () => {
    const rows = [
      utt(8, 12, [[8, 12]]),
      utt(0, 20, [[0, 20]]),
      utt(9, 10, [[9, 10]]),
    ];
    const index = buildTranscriptActiveIndex(rows);
    expect(transcriptActiveKey(index, 9.5)).toBe("0,1,2|0.0,1.0,2.0");
    expect(transcriptActiveKey(index, 15)).toBe("1|1.0");
    expect(transcriptActiveKey(index, 1)).toBe("1|1.0");
    expect(transcriptActiveKey(index, 8)).toBe("0,1|0.0,1.0");
    expect(transcriptActiveKey(index, 20)).toBe("|");
  });

  it("handles surviving spans, gaps and words beyond their row bounds", () => {
    const index = buildTranscriptActiveIndex([
      utt(0, 10, [[12, 13]], {
        timeline_spans: [
          { start: 0, end: 2 },
          { start: 8, end: 10 },
        ],
      }),
      utt(5, 6, [[5, 6]], { suppressed_only: true }),
      utt(6, 7, [[6, 7]], { mappable: false }),
    ]);
    expect(transcriptActiveKey(index, 1)).toBe("0|");
    expect(transcriptActiveKey(index, 5.5)).toBe("|");
    expect(transcriptActiveKey(index, 6.5)).toBe("|2.0");
    expect(transcriptActiveKey(index, 8)).toBe("0|");
    expect(transcriptActiveKey(index, 10)).toBe("|");
    expect(transcriptActiveKey(index, 12.5)).toBe("|0.0");
    expect(transcriptActiveKey(index, 13)).toBe("|");
  });

  it("handles no rows and instant words beyond an utterance's end", () => {
    expect(transcriptActiveKey(buildTranscriptActiveIndex([]), 1)).toBe("|");
    const index = buildTranscriptActiveIndex([utt(0, 1, [[10, 9]])]);
    expect(transcriptActiveKey(index, 0.5)).toBe("0|");
    expect(transcriptActiveKey(index, 9.99)).toBe("|0.0");
    expect(transcriptActiveKey(index, 10.01)).toBe("|0.0");
    expect(transcriptActiveKey(index, 10.06)).toBe("|");
  });
});
