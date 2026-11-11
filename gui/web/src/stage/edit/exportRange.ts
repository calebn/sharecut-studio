import {
  makeRangeTarget,
  resolveSelectionRange,
} from "../../edit/rangeSelection";
import { selectedTrackIdsOf } from "../../state/selection";
import type {
  ExactRangeTarget,
  ProjectView,
  Selection,
  TimelineSpan,
  TrackView,
} from "../../types/project";
import { trackHasSourceAudio } from "../../utils/projectMedia";
import { readLocal, writeLocal } from "../../utils/storage";
import { formatTimeShort } from "../../utils/time";

export type BounceSource = "mix" | "selected" | "soloed";

export type ExportRangeChoices = {
  source: BounceSource;
  includeMp3: boolean;
};

export const EXPORT_RANGE_DEFAULTS: Readonly<ExportRangeChoices> =
  Object.freeze({ source: "mix", includeMp3: false });

export const EXPORT_RANGE_STORAGE_KEY = "sharecut.exportRange";

const SOURCES: readonly BounceSource[] = ["mix", "selected", "soloed"];

const BOUNCEABLE_ROLES: ReadonlySet<string> = new Set([
  "dialogue",
  "music",
  "intro",
  "outro",
  "sfx",
]);

export function readExportRangeChoices(): ExportRangeChoices {
  const raw = readLocal(EXPORT_RANGE_STORAGE_KEY);
  if (raw === null) return { ...EXPORT_RANGE_DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return { ...EXPORT_RANGE_DEFAULTS };
    const { source, includeMp3 } = parsed as Record<string, unknown>;
    return {
      source: SOURCES.includes(source as BounceSource)
        ? (source as BounceSource)
        : EXPORT_RANGE_DEFAULTS.source,
      includeMp3: includeMp3 === true,
    };
  } catch {
    return { ...EXPORT_RANGE_DEFAULTS };
  }
}

export function writeExportRangeChoices(choices: ExportRangeChoices): void {
  writeLocal(
    EXPORT_RANGE_STORAGE_KEY,
    JSON.stringify({
      source: choices.source,
      includeMp3: choices.includeMp3,
    }),
  );
}

/** What Export covers: a time range when `intervals` is set, else the whole episode; `trackIds` are the selection's tracks. */
export type ExportScope = {
  intervals: TimelineSpan[] | null;
  trackIds: readonly string[];
};

export function exportScopeOf(
  project: ProjectView,
  selection: Selection,
): { ok: true; scope: ExportScope } | { ok: false; reason: string } {
  if (selection?.kind === "range" || selection?.kind === "transcriptRange") {
    const { targets, reason } = resolveSelectionRange(project, selection);
    const target = targets.length === 1 ? targets[0]! : null;
    if (!target)
      return { ok: false, reason: reason ?? "Choose one range to export" };
    return {
      ok: true,
      scope: { intervals: target.intervals, trackIds: target.track_ids },
    };
  }
  return {
    ok: true,
    scope: {
      intervals: null,
      trackIds:
        selection?.kind === "track" ? selectedTrackIdsOf(selection) : [],
    },
  };
}

const audible = (track: TrackView): boolean =>
  BOUNCEABLE_ROLES.has(track.role) &&
  trackHasSourceAudio(track) &&
  track.muted !== true;

export function bounceTracks(
  project: ProjectView,
  scope: ExportScope,
  source: BounceSource,
  solo: Readonly<Record<string, boolean>>,
): { ok: true; trackIds: string[] } | { ok: false; reason: string } {
  const bounceable = project.tracks.filter(audible).map((t) => t.id);
  const keep = (ids: readonly string[]) =>
    bounceable.filter((id) => ids.includes(id));
  if (source === "mix") {
    return bounceable.length
      ? { ok: true, trackIds: bounceable }
      : { ok: false, reason: "Nothing audible to export." };
  }
  if (source === "selected") {
    if (!scope.trackIds.length)
      return { ok: false, reason: "Select a track first." };
    const ids = keep(scope.trackIds);
    return ids.length
      ? { ok: true, trackIds: ids }
      : { ok: false, reason: "The selected tracks have nothing audible." };
  }
  const soloed = Object.entries(solo)
    .filter(([, on]) => on)
    .map(([id]) => id);
  if (!soloed.length)
    return { ok: false, reason: "Solo one or more tracks first." };
  const ids = keep(soloed);
  return ids.length
    ? { ok: true, trackIds: ids }
    : { ok: false, reason: "The soloed tracks have nothing audible." };
}

/** `trackIds` is null only for the whole episode's full mix, where the server picks the audible tracks. */
export type BounceRequest = {
  range: ExactRangeTarget | null;
  trackIds: string[] | null;
  source: BounceSource;
  includeMp3: boolean;
};

/** Tracks selected without a range export those tracks, since the full mix would ignore the selection. */
export function sourceFor(
  scope: ExportScope,
  source: BounceSource,
): BounceSource {
  return scope.intervals === null && scope.trackIds.length && source === "mix"
    ? "selected"
    : source;
}

/** The saved source, or the full mix when what it names is not available now (nothing soloed, no track selected). */
export function usableChoices(
  project: ProjectView,
  scope: ExportScope,
  choices: ExportRangeChoices,
  solo: Readonly<Record<string, boolean>>,
): ExportRangeChoices {
  const source = sourceFor(scope, choices.source);
  return bounceTracks(project, scope, source, solo).ok
    ? choices
    : { ...choices, source: "mix" };
}

export function bounceRequestOf(
  project: ProjectView,
  scope: ExportScope,
  choices: ExportRangeChoices,
  solo: Readonly<Record<string, boolean>>,
): { ok: true; request: BounceRequest } | { ok: false; reason: string } {
  const source = sourceFor(scope, choices.source);
  const tracks = bounceTracks(project, scope, source, solo);
  if (!tracks.ok) return tracks;
  const { includeMp3 } = choices;
  if (scope.intervals === null) {
    return {
      ok: true,
      request: {
        range: null,
        trackIds: source === "mix" ? null : tracks.trackIds,
        source,
        includeMp3,
      },
    };
  }
  const range = makeRangeTarget(project, scope.intervals, tracks.trackIds);
  if (!range) return { ok: false, reason: "Nothing audible in this range." };
  return {
    ok: true,
    request: { range, trackIds: tracks.trackIds, source, includeMp3 },
  };
}

/** `POST /api/export/bounce`, the same fields as MCP `bounce_audio_tool` and `podcast pipeline bounce`, plus `exact_range`. */
type BounceBody = {
  track_ids: string[] | null;
  start_s: number | null;
  end_s: number | null;
  formats: string[];
  exact_range?: ExactRangeTarget;
};

export function bounceBody(request: BounceRequest): BounceBody {
  const formats = request.includeMp3 ? ["wav", "mp3"] : ["wav"];
  if (request.range) {
    return {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats,
      exact_range: request.range,
    };
  }
  return {
    track_ids: request.trackIds,
    start_s: null,
    end_s: null,
    formats,
  };
}

const SOURCE_NOUN: Readonly<Record<BounceSource, string>> = {
  mix: "full mix",
  selected: "selected tracks",
  soloed: "soloed tracks",
};

export function bounceResultCopy(request: BounceRequest): string {
  const formats = request.includeMp3 ? "WAV and MP3" : "WAV";
  const noun = SOURCE_NOUN[request.source];
  if (!request.range) return `Exported the ${noun} as ${formats}`;
  const start = request.range.intervals[0]!.start;
  const end = request.range.intervals.at(-1)!.end;
  return `Exported ${formatTimeShort(start)}–${formatTimeShort(end)} (${noun}) as ${formats}`;
}
