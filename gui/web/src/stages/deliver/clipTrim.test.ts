import { describe, expect, it } from "vitest";
import {
  type ClipWord,
  normaliseWords,
  peaksForWindow,
  snapToWord,
  trimWindow,
} from "./clipTrim";

const WORDS: ClipWord[] = [
  { text: "So", start: 10, end: 10.4 },
  { text: "nobody", start: 10.6, end: 11.2 },
  { text: "asked", start: 11.3, end: 11.8 },
  { text: "the", start: 12, end: 12.2 },
  { text: "river", start: 12.3, end: 13 },
];

describe("snapToWord", () => {
  it.each([
    ["start", 10.5, 10.6],
    ["start", 10.45, 10.6],
    ["start", 10.4, 10.6],
    ["start", 10.2, 10],
    ["start", 0, 10],
    ["start", 99, 12.3],
    ["start", 11.3, 11.3],
    ["end", 10.5, 10.4],
    ["end", 11.5, 11.2],
    ["end", 11.6, 11.8],
    ["end", 0, 10.4],
    ["end", 99, 13],
  ] as const)("%s edge at %f goes to %f", (edge, time, expected) => {
    expect(snapToWord(WORDS, edge, time)).toBe(expected);
  });

  it.each(["start", "end"] as const)(
    "leaves %s alone with no words",
    (edge) => {
      expect(snapToWord([], edge, 42.5)).toBe(42.5);
    },
  );
});

describe("normaliseWords", () => {
  it("sorts by start then end and drops words without numeric times", () => {
    const words = [
      { text: "c", start: 12, end: 12.5 },
      { text: "a", start: 10, end: 10.5 },
      { text: "b2", start: 11, end: 11.5 },
      { text: "b1", start: 11, end: 11.2 },
      { text: "bad", start: Number.NaN, end: 1 },
      { text: "worse", start: 1, end: Number.POSITIVE_INFINITY },
    ];
    expect(normaliseWords(words).map((w) => w.text)).toEqual([
      "a",
      "b1",
      "b2",
      "c",
    ]);
    expect(words).toHaveLength(6);
  });
});

describe("snapToWord with awkward words", () => {
  it.each([
    ["unsorted", [WORDS[3], WORDS[0], WORDS[4], WORDS[1], WORDS[2]]],
    ["sorted", WORDS],
    [
      "normalised",
      normaliseWords([WORDS[3], WORDS[0], WORDS[4], WORDS[1], WORDS[2]]),
    ],
  ] as [string, ClipWord[]][])(
    "snaps the same from %s words",
    (_name, words) => {
      expect(snapToWord(words, "start", 10.5)).toBe(10.6);
      expect(snapToWord(words, "end", 11.5)).toBe(11.2);
    },
  );

  it.each([
    ["start", 10, 10],
    ["end", 10, 10],
  ] as const)("lands on a zero-length word's %s", (edge, time, expected) => {
    const words = [
      { text: "x", start: 10, end: 10 },
      { text: "y", start: 10, end: 10.5 },
    ];
    expect(snapToWord(words, edge, time)).toBe(expected);
  });
});

describe("trimWindow", () => {
  it.each([
    [{ start: 612, end: 653 }, 3120, undefined, { start: 609, end: 656 }],
    [{ start: 0, end: 33 }, 3120, undefined, { start: 0, end: 36 }],
    [{ start: 3100, end: 3120 }, 3120, undefined, { start: 3097, end: 3120 }],
    [{ start: 10, end: 20 }, 3120, 0, { start: 10, end: 20 }],
    [{ start: 10, end: 20 }, 3120, 5, { start: 5, end: 25 }],
  ])("%j in %i with margin %s", (clip, total, margin, expected) => {
    expect(trimWindow(clip, total, margin)).toEqual(expected);
  });
});

describe("peaksForWindow", () => {
  const peaks = Array.from({ length: 100 }, (_, i) => i / 100);
  it.each([
    [{ start: 0, end: 10 }, 100, 0, 10],
    [{ start: 50, end: 60 }, 100, 50, 10],
    [{ start: 95, end: 100 }, 100, 95, 5],
    [{ start: 0, end: 100 }, 100, 0, 100],
    [{ start: 10.5, end: 10.6 }, 100, 10, 1],
  ])(
    "window %j of %i seconds starts at bucket %i with %i buckets",
    (window, total, first, count) => {
      const cut = peaksForWindow(peaks, total, window);
      expect(cut).toHaveLength(count);
      expect(cut[0]).toBe(first / 100);
    },
  );
  it("is empty without peaks or a length", () => {
    expect(peaksForWindow([], 100, { start: 0, end: 10 })).toEqual([]);
    expect(peaksForWindow(peaks, 0, { start: 0, end: 10 })).toEqual([]);
  });
});
