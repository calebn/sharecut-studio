import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./offlineStore", () => ({
  removeConflictsWhere: vi.fn(async () => {}),
  removeHostConflictsWhere: vi.fn(async () => {}),
}));

import {
  type OfflineConflict,
  removeConflictsWhere,
  removeHostConflictsWhere,
} from "./offlineStore";
import { clearSupersededCorrectionConflicts } from "./supersededCorrections";

const conflict = (
  type: string,
  payload: Record<string, unknown>,
): OfflineConflict => ({
  command: {
    command_id: "c",
    client_id: "fixture-client",
    client_seq: 1,
    type,
    payload,
    created_at: 0,
  },
  kind: "refused",
  reason: "stale",
  recovery: "edit-and-resubmit",
});

describe("clearSupersededCorrectionConflicts (#746)", () => {
  beforeEach(() => {
    vi.mocked(removeConflictsWhere).mockClear();
    vi.mocked(removeHostConflictsWhere).mockClear();
  });

  it("drops refused corrections of the same track and start word", async () => {
    await clearSupersededCorrectionConflicts(
      "/tmp/ep",
      "CorrectTranscriptWord",
      { track_id: "host", word_index: 0 },
    );
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

  it("matches a phrase correction by start_word_index", async () => {
    await clearSupersededCorrectionConflicts(
      "/tmp/ep",
      "CorrectTranscriptPhrase",
      { track_id: "host", start_word_index: 3, end_word_index: 4 },
    );
    const superseded = vi.mocked(removeHostConflictsWhere).mock.calls[0]![1];
    expect(
      superseded(
        conflict("CorrectTranscriptWord", { track_id: "host", word_index: 3 }),
      ),
    ).toBe(true);
  });

  it("clears the token's conflicts for a guest", async () => {
    await clearSupersededCorrectionConflicts(
      "share:tok",
      "CorrectTranscriptWord",
      { track_id: "host", word_index: 0 },
    );
    expect(removeConflictsWhere).toHaveBeenCalledWith(
      "tok",
      expect.any(Function),
    );
    expect(removeHostConflictsWhere).not.toHaveBeenCalled();
  });

  it("does not fail the correction when cleanup fails", async () => {
    vi.mocked(removeHostConflictsWhere).mockRejectedValueOnce(new Error("idb"));
    await expect(
      clearSupersededCorrectionConflicts("/tmp/ep", "CorrectTranscriptWord", {
        track_id: "host",
        word_index: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for a non-correction command", async () => {
    await clearSupersededCorrectionConflicts(
      "/tmp/ep",
      "SetTranscriptWordSuppressed",
      { track_id: "host", word_index: 0 },
    );
    expect(removeHostConflictsWhere).not.toHaveBeenCalled();
    expect(removeConflictsWhere).not.toHaveBeenCalled();
  });
});
