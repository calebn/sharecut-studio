import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
}));

import { correctTranscriptPhrase, correctTranscriptWord } from "../api";
import { submitWordCorrection, wordCorrectionError } from "./wordCorrection";

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
    await submitWordCorrection("/tmp/ep", "host", 3, 3, "  Hello  ");
    expect(correctTranscriptWord).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      3,
      "Hello",
    );
    expect(correctTranscriptPhrase).not.toHaveBeenCalled();
  });

  it("calls correctTranscriptPhrase when end > start", async () => {
    await submitWordCorrection("/tmp/ep", "host", 3, 5, "  Hello there  ");
    expect(correctTranscriptPhrase).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      3,
      5,
      "Hello there",
    );
    expect(correctTranscriptWord).not.toHaveBeenCalled();
  });
});
