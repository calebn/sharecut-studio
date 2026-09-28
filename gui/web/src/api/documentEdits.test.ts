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
vi.mock("../state/offlineStore", () => ({
  removeConflictsWhere: vi.fn(async () => {}),
  removeHostConflictsWhere: vi.fn(async () => {}),
}));

import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  currentDocumentSeq,
  noteDocumentSeq,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import {
  type OfflineConflict,
  removeConflictsWhere,
  removeHostConflictsWhere,
} from "../state/offlineStore";
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
  vi.mocked(removeConflictsWhere).mockClear();
  vi.mocked(removeHostConflictsWhere).mockClear();
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
    vi.mocked(loadProjectPhase).mockReset();
    vi.mocked(loadProjectPhase).mockResolvedValue({});
    vi.mocked(applyDocumentSnapshot).mockClear();
    vi.mocked(useDawStore.getState).mockReturnValue({
      projectPath: "/tmp/ep",
    } as unknown as ReturnType<typeof useDawStore.getState>);
    resetDocumentSeqForTests();
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

  it("fetches the phase again when a live update lands while it loads", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(
      new ApiError("stale", null, 409),
    );
    const stale = { transcript: null };
    const fresh = { transcript: { utterances: [] } };
    vi.mocked(loadProjectPhase)
      .mockImplementationOnce(async () => {
        noteDocumentSeq(currentDocumentSeq() + 1);
        return stale;
      })
      .mockResolvedValueOnce(fresh);
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(loadProjectPhase).toHaveBeenCalledTimes(2);
    expect(applyDocumentSnapshot).toHaveBeenCalledTimes(1);
    expect(applyDocumentSnapshot).toHaveBeenCalledWith(
      { patch: fresh },
      { force: true },
    );
  });

  it("applies nothing when live updates land during every attempt", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(
      new ApiError("stale", null, 409),
    );
    vi.mocked(loadProjectPhase).mockImplementation(async () => {
      noteDocumentSeq(currentDocumentSeq() + 1);
      return {};
    });
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(loadProjectPhase).toHaveBeenCalledTimes(3);
    expect(applyDocumentSnapshot).not.toHaveBeenCalled();
  });
});

describe("transcript correction clears superseded Needs attention entries (#746)", () => {
  const conflict = (
    type: string,
    payload: Record<string, unknown>,
  ): OfflineConflict => ({
    command: { command_id: "c", client_seq: 1, type, payload, created_at: 0 },
    reason: "stale",
  });

  beforeEach(() => {
    vi.mocked(removeConflictsWhere).mockClear();
    vi.mocked(removeHostConflictsWhere).mockClear();
    vi.mocked(submitQueuedDocumentCommand).mockClear();
  });

  it("a landed correction drops refused corrections of the same track and start word", async () => {
    await correctTranscriptWord("/tmp/ep", "host", 0, "Hi", "hello");
    expect(removeHostConflictsWhere).toHaveBeenCalledWith(
      "/tmp/ep",
      expect.any(Function),
    );
    const superseded = vi.mocked(removeHostConflictsWhere).mock.calls[0]![1];
    expect(
      superseded(
        conflict("CorrectTranscriptWord", { track_id: "host", word_index: 0 }),
      ),
    ).toBe(true);
    expect(
      superseded(
        conflict("CorrectTranscriptPhrase", {
          track_id: "host",
          start_word_index: 0,
          end_word_index: 2,
        }),
      ),
    ).toBe(true);
    expect(
      superseded(
        conflict("CorrectTranscriptWord", { track_id: "host", word_index: 1 }),
      ),
    ).toBe(false);
    expect(
      superseded(
        conflict("CorrectTranscriptWord", { track_id: "guest", word_index: 0 }),
      ),
    ).toBe(false);
    expect(
      superseded(
        conflict("SetTranscriptWordSuppressed", {
          track_id: "host",
          word_index: 0,
        }),
      ),
    ).toBe(false);
  });

  it("a phrase correction matches by start_word_index", async () => {
    await correctTranscriptPhrase(
      "/tmp/ep",
      "host",
      3,
      4,
      "Hi there",
      "hello there",
    );
    const superseded = vi.mocked(removeHostConflictsWhere).mock.calls[0]![1];
    expect(
      superseded(
        conflict("CorrectTranscriptWord", { track_id: "host", word_index: 3 }),
      ),
    ).toBe(true);
  });

  it("a guest correction clears the token's conflicts", async () => {
    await correctTranscriptWord("share:tok", "host", 0, "Hi");
    expect(removeConflictsWhere).toHaveBeenCalledWith(
      "tok",
      expect.any(Function),
    );
    expect(removeHostConflictsWhere).not.toHaveBeenCalled();
  });

  it("a queued correction clears nothing", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValueOnce({
      queued: true,
    });
    await correctTranscriptWord("/tmp/ep", "host", 0, "Hi");
    expect(removeHostConflictsWhere).not.toHaveBeenCalled();
    expect(removeConflictsWhere).not.toHaveBeenCalled();
  });

  it("a refused correction clears nothing", async () => {
    vi.mocked(useDawStore.getState).mockReturnValue({
      projectPath: "/tmp/ep",
    } as unknown as ReturnType<typeof useDawStore.getState>);
    vi.mocked(submitQueuedDocumentCommand).mockRejectedValueOnce(
      new ApiError("stale", null, 409),
    );
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(removeHostConflictsWhere).not.toHaveBeenCalled();
    expect(removeConflictsWhere).not.toHaveBeenCalled();
  });

  it("a failed cleanup does not fail the correction", async () => {
    vi.mocked(removeHostConflictsWhere).mockRejectedValueOnce(new Error("idb"));
    await expect(
      correctTranscriptWord("/tmp/ep", "host", 0, "Hi"),
    ).resolves.toBeUndefined();
  });
});
