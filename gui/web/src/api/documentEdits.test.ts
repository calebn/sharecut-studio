import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));
vi.mock("../state/dawStore", () => ({
  useDawStore: { getState: vi.fn(() => ({})) },
}));

import { submitQueuedDocumentCommand } from "../services/commandQueue";
import {
  correctTranscriptPhrase,
  correctTranscriptWord,
} from "./documentEdits";

beforeEach(() => {
  vi.mocked(submitQueuedDocumentCommand).mockClear();
});

describe("correctTranscriptWord", () => {
  it("sends expected_text when provided", async () => {
    await correctTranscriptWord("/tmp/ep", "host", 3, "Hello", "helo");
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "CorrectTranscriptWord",
      { track_id: "host", word_index: 3, text: "Hello", expected_text: "helo" },
      undefined,
    );
  });

  it("omits expected_text when the argument is omitted", async () => {
    await correctTranscriptWord("/tmp/ep", "host", 3, "Hello");
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "CorrectTranscriptWord",
      { track_id: "host", word_index: 3, text: "Hello" },
      undefined,
    );
  });

  it("omits expected_text when it is null", async () => {
    await correctTranscriptWord("/tmp/ep", "host", 3, "Hello", null);
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "CorrectTranscriptWord",
      { track_id: "host", word_index: 3, text: "Hello" },
      undefined,
    );
  });
});

describe("correctTranscriptPhrase", () => {
  it("sends expected_text when provided", async () => {
    await correctTranscriptPhrase(
      "/tmp/ep",
      "host",
      3,
      5,
      "Hello there",
      "helo thar",
    );
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "CorrectTranscriptPhrase",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        text: "Hello there",
        expected_text: "helo thar",
      },
      undefined,
    );
  });

  it("omits expected_text when the argument is omitted or null", async () => {
    await correctTranscriptPhrase("/tmp/ep", "host", 3, 5, "Hello there");
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "CorrectTranscriptPhrase",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        text: "Hello there",
      },
      undefined,
    );

    await correctTranscriptPhrase("/tmp/ep", "host", 3, 5, "Hello there", null);
    expect(submitQueuedDocumentCommand).toHaveBeenLastCalledWith(
      "/tmp/ep",
      "CorrectTranscriptPhrase",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        text: "Hello there",
      },
      undefined,
    );
  });
});
