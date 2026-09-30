import { isShareProjectKey } from "../shareMode";
import { readApiFailure } from "../utils/apiError";
import { submitDocumentCommand } from "./documentEdits";
import { hostFetch } from "./documentTransport";

export interface TranscriptReplacementOptions {
  search: string;
  replacement: string;
  match_case: boolean;
}
export interface TranscriptReplacementMatch {
  track_id: string;
  source_id: string | null;
  start_word_index: number;
  end_word_index: number;
  before: string;
  after: string;
  start: number;
  end: number;
  retimes_words: boolean;
}
export interface TranscriptReplacementPreview {
  matches: TranscriptReplacementMatch[];
  count: number;
  skipped_words: number;
  preview_token: string;
}

function requireHost(projectPath: string) {
  if (isShareProjectKey(projectPath))
    throw new Error("Find and replace is only available to the host.");
}

export async function previewTranscriptReplacement(
  projectPath: string,
  options: TranscriptReplacementOptions,
): Promise<TranscriptReplacementPreview> {
  requireHost(projectPath);
  const response = await hostFetch("/api/transcript/replacement-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...options }),
  });
  if (!response.ok) throw await readApiFailure(response);
  return response.json() as Promise<TranscriptReplacementPreview>;
}

export async function replaceTranscriptMatches(
  projectPath: string,
  options: TranscriptReplacementOptions,
  previewToken: string,
) {
  requireHost(projectPath);
  return submitDocumentCommand(projectPath, "ReplaceTranscriptMatches", {
    ...options,
    preview_token: previewToken,
  });
}
