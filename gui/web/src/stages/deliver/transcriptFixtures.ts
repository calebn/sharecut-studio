import type {
  TranscriptFile,
  TranscriptOptions,
  TranscriptPreview,
} from "./transcriptLogic";
import { TRANSCRIPT_DEFAULTS } from "./transcriptLogic";

export const SAMPLE_PREVIEW: TranscriptPreview = {
  turns: 212,
  durationSec: 3120,
  language: "en",
  cueSample: "1 · 0:00 → 0:04 · Welcome back to the show.",
  shown: [
    {
      speaker: "Maya",
      startSec: 0,
      text: "Welcome back to the show. Today we are talking about editing by text.",
      colorIndex: 0,
    },
    {
      speaker: "Jonas",
      startSec: 9,
      text: "Thanks for having me. I have been looking forward to this one.",
      colorIndex: 1,
    },
    {
      speaker: "Maya",
      startSec: 17,
      text: "Let's start with how you first got into audio.",
      colorIndex: 0,
    },
  ],
};

export const SAMPLE_FILES: readonly TranscriptFile[] = [
  { name: "episode.md", bytes: 18_400, format: "md", current: true },
  { name: "episode.srt", bytes: 52_100, format: "srt", current: true },
];

export function transcriptOptions(
  over: Partial<TranscriptOptions> = {},
): TranscriptOptions {
  return {
    preview: { kind: "ready", preview: SAMPLE_PREVIEW },
    run: { phase: "idle" },
    files: [],
    choices: TRANSCRIPT_DEFAULTS,
    onChoices: () => {},
    onExport: () => {},
    onCopy: () => {},
    onPrepare: () => {},
    ...over,
  };
}
