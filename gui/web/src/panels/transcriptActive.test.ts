import { describe, expect, it } from "vitest";
import type { CombinedUtterance } from "../types/project";
import {
  findActiveUtteranceIndex,
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
  } as CombinedUtterance;
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
});
