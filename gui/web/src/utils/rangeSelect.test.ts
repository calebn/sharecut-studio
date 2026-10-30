import { describe, expect, it } from "vitest";
import {
  isRangeStep,
  NO_EARLIER_WORD_REASON,
  NO_LATER_WORD_REASON,
  ONE_WORD_REASON,
  selectedWordsMessage,
  spanBetween,
  stepWordSpan,
  wordCountOf,
} from "./rangeSelect";

const exists = (last: number) => (i: number) => i >= 0 && i <= last;

describe("stepWordSpan", () => {
  const span = { startWordIndex: 3, endWordIndex: 5 };

  it("adds a word before and after", () => {
    expect(stepWordSpan(span, { edge: "start", by: -1 }, exists(9))).toEqual({
      ok: true,
      span: { startWordIndex: 2, endWordIndex: 5 },
    });
    expect(stepWordSpan(span, { edge: "end", by: 1 }, exists(9))).toEqual({
      ok: true,
      span: { startWordIndex: 3, endWordIndex: 6 },
    });
  });

  it("drops the first and the last word", () => {
    expect(stepWordSpan(span, { edge: "start", by: 1 }, exists(9))).toEqual({
      ok: true,
      span: { startWordIndex: 4, endWordIndex: 5 },
    });
    expect(stepWordSpan(span, { edge: "end", by: -1 }, exists(9))).toEqual({
      ok: true,
      span: { startWordIndex: 3, endWordIndex: 4 },
    });
  });

  it("stops growing where the transcript ends", () => {
    expect(
      stepWordSpan(
        { startWordIndex: 0, endWordIndex: 2 },
        { edge: "start", by: -1 },
        exists(9),
      ),
    ).toEqual({ ok: false, reason: NO_EARLIER_WORD_REASON });
    expect(
      stepWordSpan(
        { startWordIndex: 7, endWordIndex: 9 },
        { edge: "end", by: 1 },
        exists(9),
      ),
    ).toEqual({ ok: false, reason: NO_LATER_WORD_REASON });
  });

  it("never trims a range below one word", () => {
    const one = { startWordIndex: 4, endWordIndex: 4 };
    expect(stepWordSpan(one, { edge: "start", by: 1 }, exists(9))).toEqual({
      ok: false,
      reason: ONE_WORD_REASON,
    });
    expect(stepWordSpan(one, { edge: "end", by: -1 }, exists(9))).toEqual({
      ok: false,
      reason: ONE_WORD_REASON,
    });
  });

  it("reads a reversed span in order", () => {
    expect(
      stepWordSpan(
        { startWordIndex: 5, endWordIndex: 3 },
        { edge: "end", by: 1 },
        exists(9),
      ),
    ).toEqual({ ok: true, span: { startWordIndex: 3, endWordIndex: 6 } });
  });
});

describe("range helpers", () => {
  it("counts and names the words", () => {
    expect(wordCountOf({ startWordIndex: 2, endWordIndex: 4 })).toBe(3);
    expect(selectedWordsMessage({ startWordIndex: 2, endWordIndex: 2 })).toBe(
      "1 word selected",
    );
    expect(selectedWordsMessage({ startWordIndex: 2, endWordIndex: 6 })).toBe(
      "5 words selected",
    );
  });

  it("orders the span between an anchor and the finger", () => {
    expect(spanBetween(6, 2)).toEqual({ startWordIndex: 2, endWordIndex: 6 });
    expect(spanBetween(2, 6)).toEqual({ startWordIndex: 2, endWordIndex: 6 });
  });

  it("accepts only a one-word step on an edge", () => {
    expect(isRangeStep({ edge: "end", by: -1 })).toBe(true);
    expect(isRangeStep({ edge: "middle", by: 1 })).toBe(false);
    expect(isRangeStep({ edge: "start", by: 2 })).toBe(false);
    expect(isRangeStep(null)).toBe(false);
  });
});
