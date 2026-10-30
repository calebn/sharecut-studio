import { apiFetch, HOST_KEY } from "./http";

export type TranscriptFormat = "txt" | "md" | "srt" | "vtt";

export type TranscriptPreviewTurn = {
  speaker: string;
  start_sec: number;
  text: string;
};

export type TranscriptExportFile = {
  format: TranscriptFormat;
  path: string;
  name: string;
  bytes: number;
  language: string;
  written: boolean;
  current: boolean;
};

export type TranscriptExportResult = {
  language: string;
  turns: number;
  duration_sec: number;
  preview: TranscriptPreviewTurn[];
  cue_sample: string | null;
  files: TranscriptExportFile[];
  text: string | null;
};

export type ExportedTranscript = {
  format: TranscriptFormat;
  path: string;
  name: string;
  mime: string;
  language: string;
  bytes: number;
  modified: string;
  current: boolean;
};

/** Writes the edited transcript, or with `dry_run` only previews it. Synchronous, not a job. */
export async function exportTranscript(
  projectPath: string,
  body: {
    formats: readonly TranscriptFormat[];
    dry_run?: boolean;
    with_text?: boolean;
  },
  opts?: { signal?: AbortSignal },
): Promise<TranscriptExportResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/transcript/export" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, ...body }),
      signal: opts?.signal,
    },
  );
  return (await res.json()) as TranscriptExportResult;
}

/** The transcript files already next to the audio, each with whether it matches the edit. */
export async function listExportedTranscripts(
  projectPath: string,
  opts?: { signal?: AbortSignal },
): Promise<ExportedTranscript[]> {
  const res = await apiFetch(
    HOST_KEY,
    {
      host: `/api/transcript/exports?path=${encodeURIComponent(projectPath)}`,
    },
    { signal: opts?.signal },
  );
  return (await res.json()) as ExportedTranscript[];
}
