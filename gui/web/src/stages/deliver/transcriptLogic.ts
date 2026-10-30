export type TranscriptFormatId = "txt" | "md" | "srt" | "vtt";

export const TRANSCRIPT_FORMATS: readonly {
  id: TranscriptFormatId;
  label: string;
  group: "read" | "captions";
}[] = [
  { id: "txt", label: "Text", group: "read" },
  { id: "md", label: "Markdown", group: "read" },
  { id: "srt", label: "SRT", group: "captions" },
  { id: "vtt", label: "VTT", group: "captions" },
];

/** What every audio export writes by default, so nothing changes unless more is chosen. */
export const TRANSCRIPT_DEFAULTS: readonly TranscriptFormatId[] = ["md", "srt"];

export type TranscriptTurn = {
  speaker: string;
  startSec: number;
  text: string;
  colorIndex: number;
};

export type TranscriptPreview = {
  /** Every turn the files hold, not only the ones listed. */
  turns: number;
  durationSec: number;
  language: string;
  shown: readonly TranscriptTurn[];
  /** The first caption cue on one line; null when there is none. */
  cueSample: string | null;
};

export type TranscriptPreviewState =
  | { kind: "loading" }
  /** Nothing is transcribed yet. */
  | { kind: "none" }
  /** There are words, and every one is cut. */
  | { kind: "allCut" }
  | { kind: "failed"; cause: string }
  | { kind: "ready"; preview: TranscriptPreview };

export type TranscriptFile = {
  name: string;
  bytes: number;
  format: TranscriptFormatId;
  /** The file matches the edited transcript. */
  current: boolean;
};

export type TranscriptRun =
  | { phase: "idle" }
  | { phase: "writing" }
  | { phase: "done"; files: readonly TranscriptFile[] }
  | { phase: "failed"; cause: string };

export type TranscriptCopyState = "idle" | "copied" | "blocked" | "failed";

/** What the Deliver host gives the Transcript section. */
export type TranscriptOptions = {
  preview: TranscriptPreviewState;
  run: TranscriptRun;
  /** Transcript files already next to the audio. */
  files: readonly TranscriptFile[];
  choices: readonly TranscriptFormatId[];
  onChoices: (next: readonly TranscriptFormatId[]) => void;
  /** An audio export or bounce is running; the export writes the transcript too. */
  exportRunning?: boolean;
  copyState?: TranscriptCopyState;
  onExport: () => void;
  onCopy: () => void;
  onRetry?: () => void;
  onPrepare: () => void;
  /** Move focus to the Export button once, then call `onFocused`. */
  focusRequested?: boolean;
  onFocused?: () => void;
};

export const TRANSCRIPT_WRITING_REASON = "Writing the transcript now.";
export const TRANSCRIPT_EXPORT_RUNNING_REASON =
  "An export is running. It writes the transcript too.";
export const TRANSCRIPT_ALL_CUT = "Every word is cut. Nothing to export.";

/** `m:ss`, or `h:mm:ss` from one hour, cut to the whole second like the files. */
export function transcriptClock(sec: number): string {
  const total = Math.floor(Math.max(0, sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

export function languageLabel(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Showing 6 of 212 turns · 52:00 · English". */
export function previewFooter(preview: TranscriptPreview): string {
  const total = preview.turns;
  const count =
    preview.shown.length >= total
      ? `${total} ${total === 1 ? "turn" : "turns"}`
      : `Showing ${preview.shown.length} of ${total} turns`;
  return `${count} · ${transcriptClock(preview.durationSec)} · ${languageLabel(preview.language)}`;
}

/** Why Export or Copy cannot run now; null when they can. */
export function transcriptBlocker(
  preview: TranscriptPreviewState,
  choices: readonly TranscriptFormatId[],
): string | null {
  if (preview.kind === "allCut") return TRANSCRIPT_ALL_CUT;
  if (preview.kind !== "ready") return "The transcript is not ready yet.";
  if (choices.length === 0) return "Choose at least one format.";
  return null;
}

export function exportLabel(count: number, again: boolean): string {
  const files = count > 1 ? ` ${count} files` : "";
  return `Export${files}${again ? " again" : ""}`;
}

/** Toggle one format, keeping the order the chips show. */
export function toggleFormat(
  choices: readonly TranscriptFormatId[],
  id: TranscriptFormatId,
): readonly TranscriptFormatId[] {
  return TRANSCRIPT_FORMATS.map((f) => f.id).filter((f) =>
    f === id ? !choices.includes(f) : choices.includes(f),
  );
}

export function filesSummary(
  files: readonly { bytes: number }[],
  formatBytes: (bytes: number) => string,
): string {
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(bytes)}`;
}
