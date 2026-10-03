import type {
  ClipRow,
  ExactRangeTarget,
  ProjectView,
  Selection,
  TimelineSpan,
} from "../types/project";
import { sourceSecOnClipToTimeline } from "../utils/timebase";
import { findTranscriptWord } from "../utils/transcript";

export function canonicalIntervals(spans: TimelineSpan[]): TimelineSpan[] {
  const ordered = spans
    .filter(
      (r) =>
        Number.isFinite(r.start) &&
        Number.isFinite(r.end) &&
        r.start >= 0 &&
        r.end > r.start,
    )
    .sort((a, b) => a.start - b.start);
  const merged: TimelineSpan[] = [];
  for (const span of ordered) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function rangeClips(project: ProjectView): ClipRow[] {
  return project.tracks.flatMap((track) => {
    const clips = project.clips.tracks[track.id] ?? [];
    if (
      clips.length ||
      track.timeline_empty ||
      !track.has_source_audio ||
      !(track.duration_sec && track.duration_sec > 0)
    )
      return clips;
    return [
      {
        id: `clip_${track.id}_full`,
        track_id: track.id,
        source_id: null,
        source_start: 0,
        source_end: track.duration_sec,
        timeline_start: 0,
        timeline_end: track.duration_sec,
        fade_in_ms: 0,
        fade_out_ms: 0,
        join_in_mode: "fade",
        mute_regions: [],
      },
    ];
  });
}

export function makeRangeTarget(
  project: ProjectView,
  spans: TimelineSpan[],
  trackIds: string[],
): ExactRangeTarget | null {
  const intervals = canonicalIntervals(spans);
  const tracks = [...new Set(trackIds)].filter((id) =>
    project.tracks.some((t) => t.id === id),
  );
  if (!intervals.length || !tracks.length) return null;
  const clips = rangeClips(project)
    .filter(
      (c) =>
        tracks.includes(c.track_id) &&
        intervals.some(
          (r) => c.timeline_start < r.end && c.timeline_end > r.start,
        ),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      track_id: c.track_id,
      source_id: c.source_id,
      source_start: c.source_start,
      source_end: c.source_end,
      timeline_start: c.timeline_start,
      fade_in_ms: c.fade_in_ms,
      fade_out_ms: c.fade_out_ms,
      join_in_mode: c.join_in_mode,
      mute_regions: c.mute_regions ?? [],
    }));
  return {
    kind: "exact_range",
    intervals,
    track_ids: tracks,
    clips,
    media_seals: Object.fromEntries(
      tracks.map((id) => [
        id,
        project.tracks.find((t) => t.id === id)?.range_media_seal ?? "",
      ]),
    ),
  };
}

export function rangeIsCurrent(
  project: ProjectView,
  target: ExactRangeTarget,
): boolean {
  const current = makeRangeTarget(project, target.intervals, target.track_ids);
  if (current === null) return false;
  return rangeTargetsEqual(current, target);
}

export function rangeTargetsEqual(
  left: ExactRangeTarget,
  right: ExactRangeTarget,
): boolean {
  const sealedFields = (range: ExactRangeTarget) => [
    range.kind,
    range.intervals.map(({ start, end }) => [start, end]),
    range.track_ids,
    range.clips.map((clip) => [
      clip.id,
      clip.track_id,
      clip.source_id,
      clip.source_start,
      clip.source_end,
      clip.timeline_start,
      clip.fade_in_ms,
      clip.fade_out_ms,
      clip.join_in_mode,
      clip.mute_regions.map(({ start_s, end_s }) => [start_s, end_s]),
    ]),
    Object.keys(range.media_seals)
      .sort()
      .map((id) => [id, range.media_seals[id]]),
  ];
  return (
    JSON.stringify(sealedFields(left)) === JSON.stringify(sealedFields(right))
  );
}

export type RangeResolution = {
  targets: ExactRangeTarget[];
  reason: string | null;
};

export function resolveSelectionRange(
  project: ProjectView,
  selection: Selection,
): RangeResolution {
  if (selection?.kind === "range")
    return { targets: [selection.target], reason: null };
  if (selection?.kind !== "transcriptRange")
    return { targets: [], reason: "Select a timeline or transcript range" };
  const words = [];
  for (
    let index = selection.startWordIndex;
    index <= selection.endWordIndex;
    index++
  ) {
    const word = findTranscriptWord(project, selection.trackId, index);
    if (word && !word.ignored && !word.suppressed && word.mappable !== false)
      words.push(word);
  }
  if (!words.length)
    return { targets: [], reason: "No audible words in this selection" };
  const sources = new Map<string | null, TimelineSpan>();
  for (const word of words) {
    const source = word.timing_target?.source_id ?? null;
    const span = sources.get(source);
    sources.set(source, {
      start: Math.min(span?.start ?? word.start, word.start),
      end: Math.max(span?.end ?? word.end, word.end),
    });
  }
  type Placement = { spans: TimelineSpan[]; tracks: string[] };
  let candidates: Placement[] = [{ spans: [], tracks: [] }];
  const fragments: { start: number; end: number; placements: ClipRow[] }[] = [];
  for (const [source, phrase] of sources) {
    const clips = rangeClips(project).filter(
      (clip) =>
        (clip.origin_track_id ?? clip.track_id) === selection.trackId &&
        clip.source_id === source &&
        clip.source_start < phrase.end &&
        clip.source_end > phrase.start,
    );
    const edges = [
      ...new Set([
        phrase.start,
        phrase.end,
        ...clips.flatMap((clip) => [
          Math.max(phrase.start, clip.source_start),
          Math.min(phrase.end, clip.source_end),
        ]),
      ]),
    ].sort((a, b) => a - b);
    for (let index = 0; index < edges.length - 1; index++) {
      const start = edges[index]!,
        end = edges[index + 1]!;
      const placements = clips.filter(
        (clip) => clip.source_start <= start && clip.source_end >= end,
      );
      if (!placements.length) continue;
      fragments.push({ start, end, placements });
    }
  }
  if (fragments.length > 1 && fragments.some((f) => f.placements.length > 1)) {
    return {
      targets: [],
      reason:
        "Repeated split fragments cannot be paired safely. Select the intended range in the timeline.",
    };
  }
  for (const { start, end, placements } of fragments) {
    candidates = candidates.flatMap((candidate) =>
      placements.map((clip) => ({
        spans: [
          ...candidate.spans,
          {
            start: sourceSecOnClipToTimeline(clip, start),
            end: sourceSecOnClipToTimeline(clip, end),
          },
        ],
        tracks: [...new Set([...candidate.tracks, clip.track_id])],
      })),
    );
    if (candidates.length > 16)
      return {
        targets: [],
        reason:
          "Several placements overlap this phrase. Select the intended range in the timeline.",
      };
  }
  const unique = new Map<string, ExactRangeTarget>();
  for (const candidate of candidates) {
    const target = makeRangeTarget(project, candidate.spans, candidate.tracks);
    if (target) unique.set(JSON.stringify(target), target);
  }
  const targets = [...unique.values()].sort(
    (a, b) => a.intervals[0]!.start - b.intervals[0]!.start,
  );
  return {
    targets,
    reason: targets.length
      ? targets.length > 1
        ? "Choose the audible occurrence"
        : null
      : "Selected words have no audible timeline placement",
  };
}
