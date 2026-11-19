import { isShareProjectKey } from "../shareMode";
import { DocumentCommand } from "../types/documentCommands.generated";
import { submitDocumentCommand } from "./documentEdits";
import { apiFetch, isHostProjectKey } from "./http";

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

function requireHostOrShare(projectPath: string) {
  if (!isHostProjectKey(projectPath) && !isShareProjectKey(projectPath))
    throw new Error("Find and replace is only available to the host.");
}

export async function previewTranscriptReplacement(
  projectPath: string,
  options: TranscriptReplacementOptions,
): Promise<TranscriptReplacementPreview> {
  requireHostOrShare(projectPath);
  const response = await apiFetch(
    projectPath,
    {
      host: "/api/transcript/replacement-preview",
      guest: "/daw/transcript/replacement-preview",
    },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isHostProjectKey(projectPath)
          ? { path: projectPath, ...options }
          : options,
      ),
    },
  );
  return response.json() as Promise<TranscriptReplacementPreview>;
}

export async function replaceTranscriptMatches(
  projectPath: string,
  options: TranscriptReplacementOptions,
  previewToken: string,
  only?: number,
) {
  requireHostOrShare(projectPath);
  return submitDocumentCommand(
    projectPath,
    DocumentCommand.ReplaceTranscriptMatches,
    {
      ...options,
      preview_token: previewToken,
      ...(only === undefined ? {} : { only }),
    },
  );
}
