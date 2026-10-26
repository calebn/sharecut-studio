import type { StatusRowState } from "../../system/StatusRow";
import { formatSeconds } from "../../system/seconds";
import type { StageId } from "../../system/verbs";

export type FormatId = "mp3" | "wav" | "flac";

/** Bytes per second of the written file; the server gives exact sizes after export. */
export const FORMATS: readonly {
  id: FormatId;
  label: string;
  bytesPerSecond: number;
}[] = [
  { id: "mp3", label: "MP3", bytesPerSecond: 16_000 },
  { id: "wav", label: "WAV", bytesPerSecond: 176_400 },
  { id: "flac", label: "FLAC", bytesPerSecond: 97_000 },
];

export type LoudnessId = "podcast" | "broadcast" | "streaming";

export const LOUDNESS: readonly {
  id: LoudnessId;
  label: string;
  lufs: number;
}[] = [
  { id: "podcast", label: "Podcast", lufs: -16 },
  { id: "broadcast", label: "Broadcast", lufs: -23 },
  { id: "streaming", label: "Streaming", lufs: -14 },
];

/** Whole episode, or the part between In and Out in seconds. */
export type ExportPart =
  | { mode: "whole" }
  | { mode: "part"; start: number; end: number };

export function partSeconds(part: ExportPart, total: number): number {
  return part.mode === "whole" ? total : Math.max(0, part.end - part.start);
}

/** In and Out stay inside the episode and keep at least a second between them. */
export function clampPart(
  next: { start: number; end: number },
  total: number,
  moved: "start" | "end",
): ExportPart {
  const gap = Math.min(1, total);
  const start = Math.min(Math.max(0, next.start), total - gap);
  const end = Math.max(Math.min(total, next.end), start + gap);
  return moved === "start"
    ? { mode: "part", start, end: Math.max(end, start + gap) }
    : { mode: "part", start: Math.min(start, end - gap), end };
}

export function estimateBytes(format: FormatId, seconds: number): number {
  const entry = FORMATS.find((f) => f.id === format);
  return Math.round((entry?.bytesPerSecond ?? 0) * seconds);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

/** 83.5 is "1:23.5". */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = (whole - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

/** "1:23.5", "83.5" or "1:23" in seconds, or null. */
export function parseClock(text: string): number | null {
  const match = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

export type ReadinessFacts = {
  suggestions: { decided: number; total: number };
  comments: { resolved: number; total: number };
  unsureWordsLeft: number;
  mixUpToDate: boolean;
  loudness: LoudnessId;
  /** Measured by the last export, in LUFS. */
  measuredLufs?: number;
  /** Highest true peak of the last export, in dBTP. */
  truePeak?: number;
  chapters: number;
  /** Seconds the edits remove; the same number Review shows. */
  editsSaved: number;
};

export type ReadinessFix = { label: string; stage: StageId; target?: string };

export type ReadinessRow = {
  id: string;
  state: StatusRowState;
  title: string;
  detail: string;
  fix?: ReadinessFix;
};

const TRUE_PEAK_LIMIT = -1.5;

export function readinessRows(facts: ReadinessFacts): ReadinessRow[] {
  const target = LOUDNESS.find((l) => l.id === facts.loudness)?.lufs ?? -16;
  const lufs = (n: number) => `${n.toFixed(1).replace("-", "−")} LUFS`;
  const dbtp = (n: number) => `${n.toFixed(1).replace("-", "−")} dBTP`;
  const openSuggestions = facts.suggestions.total - facts.suggestions.decided;
  const openComments = facts.comments.total - facts.comments.resolved;
  return [
    {
      id: "suggestions",
      state: openSuggestions === 0 ? "done" : "needs-you",
      title: "Suggestions decided",
      detail: `${facts.suggestions.decided} of ${facts.suggestions.total}`,
      fix:
        openSuggestions === 0
          ? undefined
          : { label: "Review", stage: "review", target: "suggestions" },
    },
    {
      id: "comments",
      state: openComments === 0 ? "done" : "needs-you",
      title: "Comments resolved",
      detail: `${facts.comments.resolved} of ${facts.comments.total}`,
      fix:
        openComments === 0
          ? undefined
          : { label: "Resolve", stage: "review", target: "comments" },
    },
    {
      id: "unsure",
      state: facts.unsureWordsLeft === 0 ? "done" : "needs-you",
      title: "Unsure words checked",
      detail: `${facts.unsureWordsLeft} left`,
      fix:
        facts.unsureWordsLeft === 0
          ? undefined
          : { label: "Check", stage: "review", target: "unsure-words" },
    },
    {
      id: "mix",
      state: facts.mixUpToDate ? "done" : "needs-you",
      title: "Mix up to date",
      detail: facts.mixUpToDate ? "Current" : "Edited since the last mix",
      fix: facts.mixUpToDate
        ? undefined
        : { label: "Refresh mix", stage: "edit", target: "mix" },
    },
    {
      id: "loudness",
      state: "done",
      title: "Loudness",
      detail:
        facts.measuredLufs === undefined
          ? `${lufs(target)} target, will be checked`
          : lufs(facts.measuredLufs),
    },
    {
      id: "peaks",
      state:
        facts.truePeak === undefined || facts.truePeak <= TRUE_PEAK_LIMIT
          ? "done"
          : "needs-you",
      title: `Peaks under ${dbtp(TRUE_PEAK_LIMIT)}`,
      detail:
        facts.truePeak === undefined
          ? "Checked on export"
          : dbtp(facts.truePeak),
      fix:
        facts.truePeak !== undefined && facts.truePeak > TRUE_PEAK_LIMIT
          ? { label: "Fix", stage: "edit", target: "peaks" }
          : undefined,
    },
    {
      id: "chapters",
      state: "done",
      title: "Chapters",
      detail: String(facts.chapters),
    },
    {
      id: "saved",
      state: "done",
      title: "Edits saved",
      detail: formatSeconds(facts.editsSaved),
    },
  ];
}

/** Nothing blocks Export, so the sentence only says how much is left. */
export function readinessSummary(rows: readonly ReadinessRow[]): string {
  const open = rows.filter((row) => row.state === "needs-you").length;
  if (open === 0) return "Ready to export";
  return `${open} ${open === 1 ? "thing" : "things"} left. You can still export.`;
}

export type ExportFile = { name: string; bytes: number; format: FormatId };

export type ExportState =
  | { phase: "never" }
  | { phase: "running"; progress: number; detail: string }
  | { phase: "done"; files: readonly ExportFile[]; when: string }
  | { phase: "stale"; files: readonly ExportFile[]; when: string }
  | { phase: "failed"; cause: string };

export type DeliverEnv = "app" | "browser";

/** Export until a current export exists; then Reveal in the app, Download in a browser. */
export function primaryAction(
  state: ExportState,
  env: DeliverEnv,
): "export" | "exporting" | "reveal" | "download" {
  if (state.phase === "running") return "exporting";
  if (state.phase === "done") return env === "app" ? "reveal" : "download";
  return "export";
}

export type EpisodeSettings = {
  formats: readonly FormatId[];
  loudness: LoudnessId;
  part: ExportPart;
};

/** Why Export cannot start: nothing is chosen, or the part is empty. */
export function exportBlocker(settings: EpisodeSettings): string | undefined {
  if (settings.formats.length === 0) return "Choose a format first.";
  if (settings.part.mode === "part" && settings.part.end <= settings.part.start)
    return "Out must come after In.";
  return undefined;
}

export type Chapter = { id: string; at: number; title: string };

const byTime = (a: Chapter, b: Chapter) => a.at - b.at;

export function addChapterAt(
  chapters: readonly Chapter[],
  at: number,
  id: string,
): Chapter[] {
  return [
    ...chapters,
    { id, at, title: `Chapter ${chapters.length + 1}` },
  ].sort(byTime);
}

export function retitleChapter(
  chapters: readonly Chapter[],
  id: string,
  title: string,
): Chapter[] {
  return chapters.map((c) => (c.id === id ? { ...c, title } : c));
}

export function retimeChapter(
  chapters: readonly Chapter[],
  id: string,
  at: number,
): Chapter[] {
  return chapters.map((c) => (c.id === id ? { ...c, at } : c)).sort(byTime);
}

export function removeChapter(
  chapters: readonly Chapter[],
  id: string,
): Chapter[] {
  return chapters.filter((c) => c.id !== id);
}

/** Three bars from the proposal score; never a decimal. */
export function clipStrength(score: number): 1 | 2 | 3 {
  return score >= 0.7 ? 3 : score >= 0.4 ? 2 : 1;
}

export type Clip = {
  id: string;
  title: string;
  seconds: number;
  score: number;
  approved: boolean;
};

export function approveClip(clips: readonly Clip[], id: string): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, approved: true } : c));
}

export function removeClip(clips: readonly Clip[], id: string): Clip[] {
  return clips.filter((c) => c.id !== id);
}

/** Approved clips go out with the episode; they appear as files next to it. */
export function clipFiles(clips: readonly Clip[]): ExportFile[] {
  return clips
    .filter((c) => c.approved)
    .map((c) => ({
      name: `clips/${c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.wav`,
      bytes: estimateBytes("wav", c.seconds),
      format: "wav" as const,
    }));
}
