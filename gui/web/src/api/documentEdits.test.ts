import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));
vi.mock("../state/dawStore", () => ({
  useDawStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("./project", () => ({
  loadProjectPhase: vi.fn(async () => ({})),
}));
vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentSnapshot: vi.fn(),
}));

import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { ApiError } from "../utils/apiError";
import {
  correctTranscriptPhrase,
  correctTranscriptWord,
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
} from "./documentEdits";
import { loadProjectPhase } from "./project";

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

describe("transcript correction 409 refresh (#746)", () => {
  beforeEach(() => {
    vi.mocked(loadProjectPhase).mockClear();
    vi.mocked(applyDocumentSnapshot).mockClear();
    vi.mocked(useDawStore.getState).mockReturnValue({
      projectPath: "/tmp/ep",
    } as unknown as ReturnType<typeof useDawStore.getState>);
  });

  it.each([
    [
      "correctTranscriptWord",
      () => correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ],
    [
      "correctTranscriptPhrase",
      () =>
        correctTranscriptPhrase(
          "/tmp/ep",
          "host",
          0,
          1,
          "Hi there",
          "hello there",
        ),
    ],
  ])(
    "%s loads the host's current words into the store before rethrowing a 409",
    async (_name, send) => {
      const conflict = new ApiError("stale", null, 409);
      vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(conflict);
      const patch = { transcript: null };
      vi.mocked(loadProjectPhase).mockResolvedValueOnce(patch);
      await expect(send()).rejects.toBe(conflict);
      expect(loadProjectPhase).toHaveBeenCalledWith("/tmp/ep", "detail");
      expect(applyDocumentSnapshot).toHaveBeenCalledWith(
        { patch },
        { force: true },
      );
    },
  );

  it("does not refresh on a non-409 failure", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(
      new ApiError("boom", null, 500),
    );
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ).rejects.toThrow("boom");
    expect(loadProjectPhase).not.toHaveBeenCalled();
  });

  it("still rethrows the 409 when the refresh fails", async () => {
    const conflict = new ApiError("stale", null, 409);
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(conflict);
    vi.mocked(loadProjectPhase).mockRejectedValueOnce(new Error("offline"));
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ).rejects.toBe(conflict);
    expect(applyDocumentSnapshot).not.toHaveBeenCalled();
  });

  it("does not apply the refresh when another project is open", async () => {
    vi.mocked(useDawStore.getState).mockReturnValue({
      projectPath: "/tmp/other",
    } as unknown as ReturnType<typeof useDawStore.getState>);
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(
      new ApiError("stale", null, 409),
    );
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(applyDocumentSnapshot).not.toHaveBeenCalled();
  });
});
