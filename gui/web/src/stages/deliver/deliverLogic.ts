import type { StatusRowState } from "../../system/StatusRow";
import { formatSeconds } from "../../system/seconds";
import type { StageId } from "../../types/stage";

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
): ExportPart {
  const gap = Math.min(1, total);
  const start = Math.min(Math.max(0, next.start), total - gap);
  const end = Math.max(Math.min(total, next.end), start + gap);
  return { mode: "part", start, end };
}

export function estimateBytes(format: FormatId, seconds: number): number {
  const entry = FORMATS.find((f) => f.id === format);
  return Math.round((entry?.bytesPerSecond ?? 0) * seconds);
}

/** 83.5 is "1:23.5". */
export function formatClock(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
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
  /** Without it the Loudness row is left out. */
  loudness?: LoudnessId;
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
    ...(facts.loudness === undefined && facts.measuredLufs === undefined
      ? []
      : [
          {
            id: "loudness",
            state: "done" as const,
            title: "Loudness",
            detail:
              facts.measuredLufs === undefined
                ? `${lufs(target)} target, will be checked`
                : lufs(facts.measuredLufs),
          },
        ]),
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

/** What an export was asked to write; `range` is null for the whole episode. */
export type ExportRequest = {
  settings: EpisodeSettings;
  clips: readonly Pick<Clip, "id" | "start" | "end" | "title">[];
  chapters: readonly Chapter[];
  range: TimeSpan | null;
};

export type TimeSpan = { start: number; end: number };

export type ExportState =
  | { phase: "never" }
  | { phase: "needs-model"; model: string; size: string }
  | { phase: "running"; progress: number; detail: string }
  | {
      phase: "done" | "stale";
      files: readonly ExportFile[];
      when: string;
      exported: ExportRequest;
    }
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

/** The range an export writes: a selection passed in wins, else the Deliver In and Out. */
export function planRange(
  part: ExportPart,
  selection?: TimeSpan | null,
): TimeSpan | null {
  if (selection) return selection;
  return part.mode === "part" ? { start: part.start, end: part.end } : null;
}

/** A selection from Edit that cannot be exported falls back to the Deliver In and Out. */
export function validSelection(
  selection: TimeSpan | null | undefined,
  total: number,
): TimeSpan | null {
  if (!selection) return null;
  const { start, end } = selection;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const span = { start: Math.max(0, start), end: Math.min(total, end) };
  return span.end > span.start ? span : null;
}

export function exportRequest(
  settings: EpisodeSettings,
  clips: readonly Clip[],
  chapters: readonly Chapter[],
  selection?: TimeSpan | null,
): ExportRequest {
  return {
    settings,
    clips: clips
      .filter((c) => c.approved)
      .map(({ id, start, end, title }) => ({ id, start, end, title })),
    chapters,
    range: planRange(settings.part, selection),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  [...a].sort().join("\n") === [...b].sort().join("\n");

function byId<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((x, y) => x.id.localeCompare(y.id));
}

function sameList<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
): boolean {
  return a.length === b.length && a.every((item, i) => same(item, b[i] as T));
}

const sameSpan = (a: TimeSpan | null, b: TimeSpan | null) =>
  a === null || b === null ? a === b : a.start === b.start && a.end === b.end;

/** Whether an export already covers what the page would write now. */
export function coversRequest(
  exported: ExportRequest,
  now: ExportRequest,
): boolean {
  const a = exported.settings;
  const b = now.settings;
  return (
    sameSet([...a.formats], [...b.formats]) &&
    a.loudness === b.loudness &&
    a.part.mode === b.part.mode &&
    (a.part.mode === "whole" ||
      (b.part.mode === "part" &&
        a.part.start === b.part.start &&
        a.part.end === b.part.end)) &&
    sameSpan(exported.range, now.range) &&
    sameList(
      byId(exported.clips),
      byId(now.clips),
      (x, y) =>
        x.id === y.id &&
        x.start === y.start &&
        x.end === y.end &&
        x.title === y.title,
    ) &&
    sameList(
      exported.chapters,
      now.chapters,
      (x, y) => x.id === y.id && x.at === y.at && x.title === y.title,
    )
  );
}

/** A finished export turns stale when anything it wrote has changed since. */
export function currentExportState(
  state: ExportState,
  ...now: ExportRequest[]
): ExportState {
  return state.phase === "done" &&
    !now.some((request) => coversRequest(state.exported, request))
    ? { ...state, phase: "stale" }
    : state;
}

/** Why Export cannot start: nothing is chosen, or the part is empty. */
export function exportBlocker(
  settings: EpisodeSettings,
  state?: ExportState,
): string | undefined {
  if (state?.phase === "needs-model") return "Needs the transcription model.";
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
  const taken = new Set(chapters.map((c) => c.title));
  let number = chapters.length + 1;
  while (taken.has(`Chapter ${number}`)) number += 1;
  return [...chapters, { id, at, title: `Chapter ${number}` }].sort(byTime);
}

/** Puts a removed chapter back into whatever the list holds now. */
export function restoreChapter(
  chapters: readonly Chapter[],
  chapter: Chapter,
): Chapter[] {
  return chapters.some((c) => c.id === chapter.id)
    ? [...chapters]
    : [...chapters, chapter].sort(byTime);
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
  /** Seconds into the episode. */
  start: number;
  end: number;
  score: number;
  approved: boolean;
};

export const clipSeconds = (clip: Clip) => clip.end - clip.start;

export function approveClip(clips: readonly Clip[], id: string): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, approved: true } : c));
}

export function removeClip(clips: readonly Clip[], id: string): Clip[] {
  return clips.filter((c) => c.id !== id);
}

export function retitleClip(
  clips: readonly Clip[],
  id: string,
  title: string,
): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, title } : c));
}

/** Moves a clip's In or Out, keeping a second between them. */
export function trimClip(
  clips: readonly Clip[],
  id: string,
  edge: "start" | "end",
  at: number,
  total: number,
): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    const gap = Math.min(1, c.end - c.start);
    return edge === "start"
      ? { ...c, start: Math.max(0, Math.min(at, c.end - gap)) }
      : { ...c, end: Math.min(total, Math.max(at, c.start + gap)) };
  });
}

export function restoreClip(
  clips: readonly Clip[],
  clip: Clip,
  index: number,
): Clip[] {
  if (clips.some((c) => c.id === clip.id)) return [...clips];
  const next = [...clips];
  next.splice(Math.min(index, next.length), 0, clip);
  return next;
}

/** Approved clips as files next to the episode: unique names, never empty. */
export function clipFiles(clips: readonly Clip[]): ExportFile[] {
  const used = new Set<string>();
  return clips
    .filter((c) => c.approved)
    .map((c) => {
      const slug =
        c.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "clip";
      let name = slug;
      for (let n = 2; used.has(name); n += 1) name = `${slug}-${n}`;
      used.add(name);
      return {
        name: `clips/${name}.wav`,
        bytes: estimateBytes("wav", clipSeconds(c)),
        format: "wav" as const,
      };
    });
}

/** Names for assistive technology: a blank title becomes "clip 2", a repeated one gets its place. */
export function itemNames(titles: readonly string[], noun: string): string[] {
  return titles.map((title, index) => {
    const name = title.trim();
    if (!name) return `${noun} ${index + 1}`;
    return titles.filter((t) => t.trim() === name).length > 1
      ? `${name} ${index + 1}`
      : name;
  });
}
