import { describe, expect, it } from "vitest";
import type { ProsodyOverlay } from "../types/prosody";
import { prominentWordKey, prominentWordKeys } from "./prominence";

function overlay(tracks: ProsodyOverlay["tracks"]): ProsodyOverlay {
  return { schema: "prosody_overlay.v1", tracks };
}

describe("prominentWordKeys", () => {
  it("collects keys for fresh and stale tracks", () => {
    const keys = prominentWordKeys(
      overlay([
        {
          track_id: "host",
          status: "fresh",
          segments: [],
          boundaries: [],
          prominent_words: [
            { text: "hi", score: 1, word_index: 0, timeline_sec: 0 },
          ],
          energy_db: null,
        },
        {
          track_id: "guest",
          status: "stale",
          segments: [],
          boundaries: [],
          prominent_words: [
            { text: "yo", score: 1, word_index: 2, timeline_sec: 1 },
          ],
          energy_db: null,
        },
      ]),
    );
    expect(keys.has(prominentWordKey("host", 0))).toBe(true);
    expect(keys.has(prominentWordKey("guest", 2))).toBe(true);
    expect(keys.size).toBe(2);
  });

  it("skips missing and unavailable tracks", () => {
    const keys = prominentWordKeys(
      overlay([
        {
          track_id: "host",
          status: "missing",
          segments: [],
          boundaries: [],
          prominent_words: [
            { text: "hi", score: 1, word_index: 0, timeline_sec: 0 },
          ],
          energy_db: null,
        },
        {
          track_id: "guest",
          status: "unavailable",
          segments: [],
          boundaries: [],
          prominent_words: [
            { text: "yo", score: 1, word_index: 1, timeline_sec: 0 },
          ],
          energy_db: null,
        },
      ]),
    );
    expect(keys.size).toBe(0);
  });

  it("skips words with no resolved word_index", () => {
    const keys = prominentWordKeys(
      overlay([
        {
          track_id: "host",
          status: "fresh",
          segments: [],
          boundaries: [],
          prominent_words: [
            { text: "hi", score: 1, word_index: null, timeline_sec: 0 },
          ],
          energy_db: null,
        },
      ]),
    );
    expect(keys.size).toBe(0);
  });

  it("returns an empty set for a null overlay", () => {
    expect(prominentWordKeys(null).size).toBe(0);
  });
});
