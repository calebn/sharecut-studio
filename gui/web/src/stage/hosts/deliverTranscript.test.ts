import { describe, expect, it } from "vitest";
import type { TranscriptExportResult } from "../../api";
import { previewStateOf, transcriptFilesOf } from "./deliverTranscript";

const result = (
  over: Partial<TranscriptExportResult>,
): TranscriptExportResult => ({
  language: "en",
  turns: 3,
  duration_sec: 30,
  preview: [
    { speaker: "Maya", start_sec: 0, text: "Hi." },
    { speaker: "Jonas", start_sec: 4, text: "Hello." },
    { speaker: "Maya", start_sec: 8, text: "Welcome." },
  ],
  cue_sample: null,
  files: [],
  text: null,
  ...over,
});

describe("previewStateOf", () => {
  it("reads zero turns as all cut", () => {
    expect(previewStateOf(result({ turns: 0, preview: [] }))).toEqual({
      kind: "allCut",
    });
  });

  it("gives each speaker one stable colour", () => {
    const state = previewStateOf(result({}));
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.preview.shown.map((t) => t.colorIndex)).toEqual([0, 1, 0]);
    expect(state.preview.durationSec).toBe(30);
  });
});

describe("transcriptFilesOf", () => {
  it("keeps only what the section shows", () => {
    expect(
      transcriptFilesOf([
        {
          format: "md",
          path: "/x/episode.md",
          name: "episode.md",
          mime: "text/markdown",
          language: "en",
          bytes: 9,
          modified: "2026-10-30T00:00:00Z",
          current: false,
        },
      ]),
    ).toEqual([{ name: "episode.md", bytes: 9, format: "md", current: false }]);
  });
});
