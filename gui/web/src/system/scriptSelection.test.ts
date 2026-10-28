import { describe, expect, it } from "vitest";
import { CUT, patchWords, SCRIPT_TURNS, spanPatch } from "./scriptFixtures";
import type { ScriptPiece, ScriptStop, ScriptTurn } from "./scriptPieces";
import {
  dragEdge,
  extendTo,
  marginStep,
  navigate,
  nearestStop,
  type StopRect,
  type StopRects,
  selectionSummary,
  selectionText,
  spanOf,
  stepEdge,
  trackSpans,
  verticalStop,
} from "./scriptSelection";

// word 0, word 1, a cut pill over 2 to 4, word 5, a run over 6 to 7, word 8.
const stops: ScriptStop[] = [
  { kind: "word", start: 0, end: 0 },
  { kind: "word", start: 1, end: 1 },
  { kind: "cut", start: 2, end: 4, id: "c" },
  { kind: "word", start: 5, end: 5 },
  { kind: "suggestion", start: 6, end: 7, id: "s" },
  { kind: "word", start: 8, end: 8 },
];
const words = (anchor: number, head: number) =>
  ({ kind: "words", anchor, head }) as const;

describe("navigate without Shift", () => {
  it("moves the caret to the start of the place it reaches", () => {
    expect(navigate(stops, 1, "ArrowRight", false, null)).toEqual({
      to: 2,
      caret: 2,
    });
    expect(navigate(stops, 3, "ArrowLeft", false, null)).toEqual({
      to: 2,
      caret: 2,
    });
    expect(navigate(stops, 3, "Home", false, null)).toEqual({
      to: 0,
      caret: 0,
    });
    expect(navigate(stops, 3, "End", false, null)).toEqual({ to: 5, caret: 8 });
  });

  it("reports nothing at the ends", () => {
    expect(navigate(stops, 5, "ArrowRight", false, null)).toBeNull();
    expect(navigate(stops, 0, "ArrowLeft", false, null)).toBeNull();
    expect(navigate(stops, 0, "Home", false, null)).toBeNull();
  });

  it("reports nothing without stops", () => {
    expect(navigate([], 0, "ArrowRight", false, null)).toBeNull();
  });
});

describe("navigate with Shift", () => {
  it("starts from the place the move began", () => {
    expect(navigate(stops, 0, "ArrowRight", true, null)).toEqual({
      to: 1,
      selection: words(0, 1),
    });
    expect(navigate(stops, 1, "ArrowLeft", true, null)).toEqual({
      to: 0,
      selection: words(1, 0),
    });
  });

  it("takes the far edge of a pill in the direction of travel", () => {
    expect(navigate(stops, 1, "ArrowRight", true, words(1, 1))).toEqual({
      to: 2,
      selection: words(1, 4),
    });
    expect(navigate(stops, 3, "ArrowLeft", true, words(5, 5))).toEqual({
      to: 2,
      selection: words(5, 2),
    });
  });

  it("takes the whole run of a suggestion going right", () => {
    expect(navigate(stops, 3, "ArrowRight", true, words(5, 5))).toEqual({
      to: 4,
      selection: words(5, 7),
    });
  });

  it("starts from the near edge of a pill it leaves", () => {
    expect(navigate(stops, 2, "ArrowRight", true, null)).toEqual({
      to: 3,
      selection: words(2, 5),
    });
    expect(navigate(stops, 2, "ArrowLeft", true, null)).toEqual({
      to: 1,
      selection: words(4, 1),
    });
  });

  it("shrinks when the head comes back instead of flipping", () => {
    expect(navigate(stops, 3, "ArrowLeft", true, words(1, 5))).toEqual({
      to: 2,
      selection: words(1, 4),
    });
    expect(navigate(stops, 2, "ArrowLeft", true, words(1, 4))).toEqual({
      to: 1,
      selection: words(1, 1),
    });
  });

  it("extends to the ends with Home and End", () => {
    expect(navigate(stops, 3, "End", true, words(3, 3))).toEqual({
      to: 5,
      selection: words(3, 8),
    });
    expect(navigate(stops, 3, "Home", true, null)).toEqual({
      to: 0,
      selection: words(5, 0),
    });
  });

  it("starts again from the focus when a cut is selected", () => {
    expect(
      navigate(stops, 3, "ArrowRight", true, { kind: "cut", id: "c" }),
    ).toEqual({ to: 4, selection: words(5, 7) });
  });

  it("reports nothing when the selection would stay as it is", () => {
    expect(navigate(stops, 5, "ArrowRight", true, words(3, 8))).toBeNull();
  });
});

describe("extendTo", () => {
  it("keeps the anchor and lands the head on the edge of what it reached", () => {
    expect(extendTo(5, { start: 2, end: 4 })).toEqual(words(5, 2));
    expect(extendTo(1, { start: 2, end: 4 })).toEqual(words(1, 4));
    expect(extendTo(3, { start: 2, end: 4 })).toEqual(words(3, 3));
  });
});

describe("spanOf", () => {
  it("orders the anchor and head and ignores a cut", () => {
    expect(spanOf(words(7, 3))).toEqual({ start: 3, end: 7 });
    expect(spanOf({ kind: "cut", id: "c" })).toBeNull();
    expect(spanOf(null)).toBeNull();
  });
});

describe("selectionSummary", () => {
  const word = (index: number, text: string): ScriptPiece => ({
    kind: "word",
    word: { index, text },
  });
  const pieces: ScriptPiece[] = [
    word(0, "a"),
    word(1, "b"),
    {
      kind: "cut",
      id: "c",
      start: 2,
      end: 3,
      removed: "1.1 s",
      words: "x y",
    },
    { kind: "suggestion", id: "s", start: 4, end: 4, text: "um" },
    {
      kind: "muted",
      words: [
        { index: 5, text: "m1" },
        { index: 6, text: "m2" },
      ],
    },
    ...Array.from({ length: 20 }, (_, at) => word(7 + at, `w${7 + at}`)),
  ];

  it("reads a range with its pill, run and muted words in order", () => {
    expect(selectionSummary(pieces, words(1, 5))).toBe(
      "5 words selected: b cut x y um m1",
    );
  });

  it("reads a single word, a cut and a suggestion", () => {
    expect(selectionSummary(pieces, words(0, 0))).toBe("1 word selected: a");
    expect(selectionSummary(pieces, { kind: "cut", id: "c" })).toBe(
      "Cut selected, 1.1 s removed",
    );
    expect(selectionSummary(pieces, { kind: "suggestion", id: "s" })).toBe(
      "Suggested cut selected: um",
    );
  });

  it("cuts a long range short and says nothing for no selection", () => {
    expect(selectionSummary(pieces, words(7, 26))).toBe(
      "20 words selected: w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 ...",
    );
    expect(selectionSummary(pieces, null)).toBe("");
  });
});

const rect = (left: number, right: number, top: number): StopRect => ({
  left,
  right,
  top,
  bottom: top + 20,
});
const box = (left: number, right: number, top: number): StopRects => [
  rect(left, right, top),
];

// Line 0 holds stops 0 to 2, line 1 stops 3 and 4, line 2 stop 5.
const rects: (StopRects | null)[] = [
  box(0, 40, 0),
  box(50, 90, 0),
  box(100, 200, 0),
  box(0, 30, 26),
  box(40, 160, 26),
  box(0, 60, 52),
];

describe("verticalStop", () => {
  it("lands on the place under the column, or the nearest one on that line", () => {
    expect(verticalStop(rects, 1, 1, 70)).toBe(4);
    expect(verticalStop(rects, 2, 1, 150)).toBe(4);
    expect(verticalStop(rects, 0, 1, 10)).toBe(3);
    expect(verticalStop(rects, 4, 1, 100)).toBe(5);
    expect(verticalStop(rects, 4, -1, 60)).toBe(1);
    expect(verticalStop(rects, 3, -1, 500)).toBe(2);
  });

  it("takes the earlier place when two are equally far", () => {
    expect(verticalStop(rects, 4, -1, 95)).toBe(1);
  });

  it("finds nothing past the first or last line", () => {
    expect(verticalStop(rects, 0, -1, 10)).toBeNull();
    expect(verticalStop(rects, 5, 1, 10)).toBeNull();
  });

  it("skips places that are not drawn and treats a few pixels of drift as one line", () => {
    const drift = [
      box(0, 40, 0),
      null,
      null,
      box(0, 30, 27),
      box(40, 160, 25),
      null,
    ];
    expect(verticalStop(drift, 0, 1, 100)).toBe(4);
    expect(verticalStop(drift, 4, 1, 0)).toBeNull();
    expect(verticalStop([null], 0, 1, 0)).toBeNull();
  });
});

describe("wrapped places", () => {
  // Stop 1 wraps: its first line ends line 0 and its second begins line 1.
  const wrapped: (StopRects | null)[] = [
    box(0, 40, 0),
    [rect(50, 200, 0), rect(0, 80, 26)],
    box(100, 160, 26),
    box(0, 60, 52),
  ];

  it("goes down from the last line of a wrapped place and up from its first", () => {
    expect(verticalStop(wrapped, 1, 1, 10)).toBe(3);
    expect(verticalStop(wrapped, 1, -1, 10)).toBeNull();
    expect(verticalStop(wrapped, 3, -1, 20)).toBe(1);
    expect(verticalStop(wrapped, 3, -1, 130)).toBe(2);
  });

  it("reaches a wrapped place on any of its lines", () => {
    expect(verticalStop(wrapped, 0, 1, 20)).toBe(1);
    expect(nearestStop(wrapped, 40, 30)).toBe(1);
    expect(nearestStop(wrapped, 190, 5)).toBe(1);
    expect(nearestStop(wrapped, 130, 30)).toBe(2);
  });
});

describe("nearestStop", () => {
  it("picks the line first and the place along it second", () => {
    expect(nearestStop(rects, 20, 30)).toBe(3);
    expect(nearestStop(rects, 500, 5)).toBe(2);
    expect(nearestStop(rects, 70, 24)).toBe(4);
    expect(nearestStop(rects, 10, 200)).toBe(5);
  });

  it("finds nothing when no place is drawn", () => {
    expect(nearestStop([], 0, 0)).toBeNull();
    expect(nearestStop([null, null], 0, 0)).toBeNull();
  });
});

describe("navigate by line", () => {
  const vertical = { rects, goalX: 70 };

  it("moves the caret to the place on the next or previous line", () => {
    expect(navigate(stops, 1, "ArrowDown", false, null, vertical)).toEqual({
      to: 4,
      caret: 6,
    });
    expect(navigate(stops, 4, "ArrowUp", false, null, vertical)).toEqual({
      to: 1,
      caret: 1,
    });
  });

  it("extends the selection to the far edge of the place it reaches", () => {
    expect(navigate(stops, 1, "ArrowDown", true, null, vertical)).toEqual({
      to: 4,
      selection: words(1, 7),
    });
    expect(navigate(stops, 4, "ArrowUp", true, words(1, 7), vertical)).toEqual({
      to: 1,
      selection: words(1, 1),
    });
  });

  it("does nothing on the first or last line or without positions", () => {
    expect(navigate(stops, 0, "ArrowUp", false, null, vertical)).toBeNull();
    expect(navigate(stops, 5, "ArrowDown", true, null, vertical)).toBeNull();
    expect(navigate(stops, 1, "ArrowDown", false, null)).toBeNull();
  });
});

describe("dragEdge", () => {
  it("moves the start or the end onto the place it is dragged to", () => {
    expect(dragEdge(stops, words(1, 5), "start", stops[0])).toEqual(
      words(0, 5),
    );
    expect(dragEdge(stops, words(1, 5), "end", stops[5])).toEqual(words(1, 8));
    expect(dragEdge(stops, words(5, 8), "start", stops[2])).toEqual(
      words(2, 8),
    );
    expect(dragEdge(stops, words(0, 1), "end", stops[4])).toEqual(words(0, 7));
  });

  it("stops the start on the last place and the end on the first", () => {
    expect(dragEdge(stops, words(1, 5), "start", stops[5])).toEqual(
      words(5, 5),
    );
    expect(dragEdge(stops, words(1, 5), "end", stops[0])).toEqual(words(1, 1));
  });

  it("keeps which side the anchor is on", () => {
    expect(dragEdge(stops, words(5, 1), "start", stops[0])).toEqual(
      words(5, 0),
    );
    expect(dragEdge(stops, words(5, 1), "end", stops[5])).toEqual(words(8, 1));
  });

  it("reports nothing when the edge stays or the selection is not words", () => {
    expect(dragEdge(stops, words(1, 5), "start", stops[1])).toBeNull();
    expect(dragEdge(stops, words(1, 1), "start", stops[3])).toBeNull();
    expect(
      dragEdge(stops, { kind: "cut", id: "c" }, "end", stops[5]),
    ).toBeNull();
    expect(dragEdge(stops, null, "end", stops[5])).toBeNull();
  });
});

describe("stepEdge", () => {
  it("moves the start one place back to grow and forward to shrink", () => {
    expect(stepEdge(stops, words(1, 5), "start", -1)).toEqual(words(0, 5));
    expect(stepEdge(stops, words(1, 5), "start", 1)).toEqual(words(2, 5));
  });

  it("moves the end one place on to grow and back to shrink, taking a run whole", () => {
    expect(stepEdge(stops, words(1, 5), "end", 1)).toEqual(words(1, 7));
    expect(stepEdge(stops, words(1, 5), "end", -1)).toEqual(words(1, 4));
  });

  it("does not shrink below one place or grow past the ends", () => {
    expect(stepEdge(stops, words(1, 1), "start", 1)).toBeNull();
    expect(stepEdge(stops, words(1, 1), "end", -1)).toBeNull();
    expect(stepEdge(stops, words(0, 8), "end", 1)).toBeNull();
    expect(stepEdge(stops, words(0, 8), "start", -1)).toBeNull();
  });

  it("does nothing without a run of words", () => {
    expect(stepEdge(stops, null, "end", 1)).toBeNull();
    expect(stepEdge([], words(1, 5), "end", 1)).toBeNull();
    expect(stepEdge(stops, words(40, 41), "end", 1)).toBeNull();
  });
});

describe("marginStep", () => {
  const both = ["speaker", "time"] as const;

  it("walks the controls with Up and Down", () => {
    expect(marginStep(both, 0, "ArrowDown")).toEqual({
      kind: "control",
      at: 1,
    });
    expect(marginStep(both, 1, "ArrowUp")).toEqual({ kind: "control", at: 0 });
    expect(marginStep(both, 1, "ArrowDown")).toBeNull();
    expect(marginStep(both, 0, "ArrowUp")).toBeNull();
  });

  it("returns to the words with Right and leaves for the turn before with Left", () => {
    expect(marginStep(both, 0, "ArrowRight")).toEqual({ kind: "text" });
    expect(marginStep(both, 1, "ArrowLeft")).toEqual({ kind: "before" });
    expect(marginStep(both, 0, "x")).toBeNull();
  });
});

describe("trackSpans", () => {
  const two = (speakers: string[]): ScriptTurn[] =>
    SCRIPT_TURNS.map((turn, at) => ({ ...turn, speakerId: speakers[at] }));

  it("covers each speaker's words on that speaker's track when a span crosses a speaker change", () => {
    expect(trackSpans(SCRIPT_TURNS, { start: 17, end: 42 })).toEqual([
      {
        speakerId: "maya",
        startIndex: 17,
        endIndex: 19,
        first: "episode:17",
        last: "episode:19",
        turnIds: ["t1"],
      },
      {
        speakerId: "anneke",
        startIndex: 20,
        endIndex: 42,
        first: "episode:20",
        last: "episode:42",
        turnIds: ["t2", "t3"],
      },
    ]);
  });

  it("gives a track that speaks on both sides of another one a single run", () => {
    const [a, b] = trackSpans(two(["a", "b", "a", "b"]), {
      start: 18,
      end: 41,
    });
    expect([a.speakerId, a.startIndex, a.endIndex, a.turnIds]).toEqual([
      "a",
      18,
      41,
      ["t1", "t3"],
    ]);
    expect([b.speakerId, b.startIndex, b.endIndex]).toEqual(["b", 20, 39]);
    const three = trackSpans(two(["a", "b", "a", "b"]), { start: 18, end: 44 });
    expect(three.map((t) => [t.speakerId, t.startIndex, t.endIndex])).toEqual([
      ["a", 18, 44],
      ["b", 20, 39],
    ]);
  });

  it("counts cut words as the track's own, and gives nothing without a span", () => {
    const cut = patchWords(SCRIPT_TURNS, spanPatch(18, 19, { mark: CUT }));
    expect(trackSpans(cut, { start: 18, end: 19 })).toHaveLength(1);
    expect(trackSpans(cut, null)).toEqual([]);
  });
});

describe("selectionText", () => {
  it("is a turn to a line and leaves out a collapsed cut", () => {
    const cut = patchWords(SCRIPT_TURNS, spanPatch(14, 14, { mark: CUT }));
    expect(selectionText(cut, words(12, 21), false)).toBe(
      "small room sound like a large one.\nThanks for",
    );
  });

  it("copies struck words when the cut text shows, and nothing for a cut selection", () => {
    const cut = patchWords(SCRIPT_TURNS, spanPatch(14, 14, { mark: CUT }));
    expect(selectionText(cut, words(13, 15), true)).toBe("room can sound");
    expect(selectionText(cut, { kind: "cut", id: "cut-1" }, false)).toBe("");
    expect(selectionText(cut, null, false)).toBe("");
  });

  it("reads a backwards selection in reading order", () => {
    expect(selectionText(SCRIPT_TURNS, words(2, 0), false)).toBe(
      "Welcome back to",
    );
  });
});

describe("right-to-left lines", () => {
  // One line of three words laid out right to left: word 0 is the rightmost.
  const rtl: StopRects[] = [
    [{ top: 0, bottom: 20, left: 200, right: 250 }],
    [{ top: 0, bottom: 20, left: 140, right: 190 }],
    [{ top: 0, bottom: 20, left: 80, right: 130 }],
  ];

  it("finds the place by where it is drawn, not by its order", () => {
    expect(nearestStop(rtl, 220, 10)).toBe(0);
    expect(nearestStop(rtl, 100, 10)).toBe(2);
    expect(nearestStop(rtl, 135, 10)).toBe(1);
  });

  it("extends by reading order, so a pointer to the left of the anchor selects forward", () => {
    const stops: ScriptStop[] = [0, 1, 2].map((i) => ({
      kind: "word",
      start: i,
      end: i,
    }));
    const reached = nearestStop(rtl, 100, 10) ?? 0;
    expect(extendTo(0, stops[reached])).toEqual(words(0, 2));
    expect(extendTo(2, stops[nearestStop(rtl, 220, 10) ?? 0])).toEqual(
      words(2, 0),
    );
  });
});
