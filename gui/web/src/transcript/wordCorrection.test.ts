import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
}));

import { correctTranscriptPhrase, correctTranscriptWord } from "../api";
import {
  appliedCorrectionSpan,
  reconciledCorrectionBaseline,
  submitWordCorrection,
  wordCorrectionError,
} from "./wordCorrection";

beforeEach(() => {
  vi.mocked(correctTranscriptWord).mockClear();
  vi.mocked(correctTranscriptPhrase).mockClear();
});

describe("wordCorrectionError", () => {
  it("returns the end-index message for a NaN end index", () => {
    expect(wordCorrectionError("hi", 2, Number.NaN)).toBe(
      "End index must be an integer ≥ start word index",
    );
  });

  it("returns the end-index message when end < start", () => {
    expect(wordCorrectionError("hi", 2, 1)).toBe(
      "End index must be an integer ≥ start word index",
    );
  });

  it("returns the empty message for blank text", () => {
    expect(wordCorrectionError("   ", 0, 0)).toBe("Text cannot be empty");
  });

  it("returns null for valid input", () => {
    expect(wordCorrectionError("hi", 0, 1)).toBeNull();
  });
});

describe("submitWordCorrection", () => {
  it("calls correctTranscriptWord when start === end", async () => {
    await submitWordCorrection("/tmp/ep", "host", 3, 3, "  Hello  ", "helo");
    expect(correctTranscriptWord).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      3,
      "Hello",
      "helo",
    );
    expect(correctTranscriptPhrase).not.toHaveBeenCalled();
  });

  it("calls correctTranscriptPhrase when end > start", async () => {
    await submitWordCorrection(
      "/tmp/ep",
      "host",
      3,
      5,
      "  Hello there  ",
      "helo thar",
    );
    expect(correctTranscriptPhrase).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      3,
      5,
      "Hello there",
      "helo thar",
    );
    expect(correctTranscriptWord).not.toHaveBeenCalled();
  });

  it("forwards undefined when expectedText is omitted", async () => {
    await submitWordCorrection("/tmp/ep", "host", 3, 3, "Hello");
    expect(correctTranscriptWord).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      3,
      "Hello",
      undefined,
    );
  });
});

describe("appliedCorrectionSpan", () => {
  it("keeps the single index for a single-word fix", () => {
    expect(appliedCorrectionSpan(3, 3, "  Hello  ")).toEqual({
      endWordIndex: 3,
      text: "Hello",
    });
  });

  it("keeps the single index even when the corrected text has extra words", () => {
    expect(appliedCorrectionSpan(3, 3, "New York")).toEqual({
      endWordIndex: 3,
      text: "New York",
    });
  });

  it("reindexes a phrase fix by the applied text's token count", () => {
    expect(appliedCorrectionSpan(0, 1, "  Hello   there  ")).toEqual({
      endWordIndex: 1,
      text: "Hello there",
    });
  });

  it("moves the end index when a phrase fix adds a word", () => {
    expect(appliedCorrectionSpan(0, 1, "hello where new")).toEqual({
      endWordIndex: 2,
      text: "hello where new",
    });
  });

  it("moves the end index back when a phrase fix drops words", () => {
    expect(appliedCorrectionSpan(0, 2, "hi")).toEqual({
      endWordIndex: 0,
      text: "hi",
    });
  });
});

describe("reconciledCorrectionBaseline", () => {
  const texts = (words: string[]) =>
    new Map(words.map((w, i) => [i, w] as const));
  const a = { endWordIndex: 0, text: "hello" };
  const b = { endWordIndex: 0, text: "Hello" };
  const c = { endWordIndex: 0, text: "World" };
  const ab = { before: a, after: b };
  const bc = { before: b, after: c };

  it("returns null when the current baseline still matches", () => {
    expect(
      reconciledCorrectionBaseline(texts(["Hello"]), 0, b, [ab]),
    ).toBeNull();
  });

  it("Undo returns before", () => {
    expect(reconciledCorrectionBaseline(texts(["hello"]), 0, b, [ab])).toEqual(
      a,
    );
  });

  it("Redo returns after", () => {
    expect(reconciledCorrectionBaseline(texts(["Hello"]), 0, a, [ab])).toEqual(
      b,
    );
  });

  it("returns null for a change to text never applied", () => {
    expect(
      reconciledCorrectionBaseline(texts(["Howdy"]), 0, b, [ab]),
    ).toBeNull();
  });

  it("walks newest first across a chain", () => {
    expect(
      reconciledCorrectionBaseline(texts(["Hello"]), 0, c, [ab, bc]),
    ).toEqual(b);
  });

  it("follows a phrase Apply that changed the word count", () => {
    const before = { endWordIndex: 1, text: "hello there" };
    const after = { endWordIndex: 2, text: "Hello there new" };
    expect(
      reconciledCorrectionBaseline(texts(["hello", "there"]), 0, after, [
        { before, after },
      ]),
    ).toEqual(before);
  });

  it("an Undo of an Apply sent unguarded returns its unverified before", () => {
    const unverified = { endWordIndex: 0, text: null };
    expect(
      reconciledCorrectionBaseline(texts(["hello"]), 0, b, [
        { before: unverified, after: b },
      ]),
    ).toEqual(unverified);
  });

  it("keeps an unguarded Apply's after while the words still read it", () => {
    expect(
      reconciledCorrectionBaseline(texts(["Hello"]), 0, b, [
        { before: { endWordIndex: 0, text: null }, after: b },
      ]),
    ).toBeNull();
  });
});
