import { isShareProjectKey } from "../shareMode";
import type {
  TranscriptTimingTarget,
  TranscriptWordView,
} from "../types/project";
import { readApiFailure } from "../utils/apiError";
import type { MediaRef } from "../waveform/types";
import { submitDocumentCommand } from "./documentEdits";
import { hostFetch } from "./documentTransport";

export interface WordTimingContext {
  target: TranscriptTimingTarget;
  expected_token: string;
  word: Pick<TranscriptWordView, "text" | "start" | "end" | "ignored">;
  neighbors: { word_index: number; text: string; start: number; end: number }[];
  media: {
    ref: MediaRef;
    duration_sec: number | null;
    sample_rate: number | null;
    cache_key: string;
  };
  window: { start: number; end: number };
  warnings: string[];
  transcript_gate: boolean;
}

export async function loadWordTimingContext(
  projectPath: string,
  target: TranscriptTimingTarget,
  word: Pick<TranscriptWordView, "text" | "start" | "end">,
): Promise<WordTimingContext> {
  if (isShareProjectKey(projectPath))
    throw new Error("Timing changes require the host project.");
  const response = await hostFetch("/api/transcript/word-timing-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      target,
      expected_word: { text: word.text, start: word.start, end: word.end },
    }),
  });
  if (!response.ok) throw await readApiFailure(response);
  return response.json() as Promise<WordTimingContext>;
}

export function saveWordTiming(
  projectPath: string,
  context: WordTimingContext,
  start: number,
  end: number,
) {
  return submitDocumentCommand(projectPath, "SetTranscriptWordTiming", {
    target: context.target,
    expected_token: context.expected_token,
    start,
    end,
  });
}
