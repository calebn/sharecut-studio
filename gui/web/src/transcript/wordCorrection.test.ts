import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  correctTranscriptWord: vi.fn(async () => {}),
  correctTranscriptPhrase: vi.fn(async () => {}),
}));

import { correctTranscriptPhrase, correctTranscriptWord } from "../api";
import { submitWordCorrection } from "./wordCorrection";

beforeEach(() => {
  vi.mocked(correctTranscriptWord).mockClear();
  vi.mocked(correctTranscriptPhrase).mockClear();
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
