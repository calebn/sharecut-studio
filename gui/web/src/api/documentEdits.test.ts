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
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
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

describe("setTranscriptWordSuppressed", () => {
  it("sends expected_text when provided", async () => {
    await setTranscriptWordSuppressed("/tmp/ep", "host", 3, true, "hello");
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "SetTranscriptWordSuppressed",
      {
        track_id: "host",
        word_index: 3,
        suppressed: true,
        expected_text: "hello",
      },
      undefined,
    );
  });

  it("omits expected_text when the argument is omitted or null", async () => {
    await setTranscriptWordSuppressed("/tmp/ep", "host", 3, true);
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "SetTranscriptWordSuppressed",
      { track_id: "host", word_index: 3, suppressed: true },
      undefined,
    );

    await setTranscriptWordSuppressed("/tmp/ep", "host", 3, true, null);
    expect(submitQueuedDocumentCommand).toHaveBeenLastCalledWith(
      "/tmp/ep",
      "SetTranscriptWordSuppressed",
      { track_id: "host", word_index: 3, suppressed: true },
      undefined,
    );
  });
});

describe("setTranscriptWordsIgnored", () => {
  it("sends expected_text when provided", async () => {
    await setTranscriptWordsIgnored(
      "/tmp/ep",
      "host",
      3,
      5,
      true,
      "hello there",
    );
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "SetTranscriptWordsIgnored",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        ignored: true,
        expected_text: "hello there",
      },
      undefined,
    );
  });

  it("omits expected_text when the argument is omitted or null", async () => {
    await setTranscriptWordsIgnored("/tmp/ep", "host", 3, 5, true);
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "SetTranscriptWordsIgnored",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        ignored: true,
      },
      undefined,
    );

    await setTranscriptWordsIgnored("/tmp/ep", "host", 3, 5, true, null);
    expect(submitQueuedDocumentCommand).toHaveBeenLastCalledWith(
      "/tmp/ep",
      "SetTranscriptWordsIgnored",
      {
        track_id: "host",
        start_word_index: 3,
        end_word_index: 5,
        ignored: true,
      },
      undefined,
    );
  });
});
