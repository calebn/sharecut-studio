import type { SegmentKind, SegmentSaveRequest } from "../api";
import { selectedClipIdsOf } from "../state/selection";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import { formatTimeShort } from "../utils/time";
import { timelineEndSec } from "./pickupTarget";
import { resolveSelectionRange } from "./rangeSelection";

export const SEGMENT_EDGE_SEC = 120;

export const SEGMENT_KINDS: readonly SegmentKind[] = [
  "intro",
  "outro",
  "sponsor",
  "sting",
  "other",
];

export type SegmentSelectionRequest = Pick<
  SegmentSaveRequest,
  "clip_ids" | "time_range"
>;

export type SegmentSelection = {
  ok: true;
  request: SegmentSelectionRequest;
  clipCount: number;
  startSec: number;
  endSec: number;
  defaultKind: SegmentKind;
  summary: string;
};

export type SegmentSelectionRefusal = { ok: false; reason: string };

export const NO_SEGMENT_SELECTION = "Select a clip or a range to save";

export function guessSegmentKind(
  startSec: number,
  endSec: number,
  timelineEnd: number,
): SegmentKind {
  if (startSec <= SEGMENT_EDGE_SEC) return "intro";
  if (endSec >= timelineEnd - SEGMENT_EDGE_SEC) return "outro";
  return "other";
}

export function segmentSummary(clipCount: number, durationSec: number): string {
  return `${clipCount} ${clipCount === 1 ? "clip" : "clips"}, ${formatTimeShort(durationSec)}`;
}

function found(
  project: ProjectView,
  request: SegmentSelectionRequest,
  clipCount: number,
  startSec: number,
  endSec: number,
): SegmentSelection {
  return {
    ok: true,
    request,
    clipCount,
    startSec,
    endSec,
    defaultKind: guessSegmentKind(startSec, endSec, timelineEndSec(project)),
    summary: segmentSummary(clipCount, endSec - startSec),
  };
}

const savedClips = (project: ProjectView): ClipRow[] =>
  project.tracks.flatMap((track) => project.clips.tracks[track.id] ?? []);

const secondsText = (sec: number) => sec.toFixed(3);

export function segmentSelectionOf(
  project: ProjectView | null,
  selection: Selection,
): SegmentSelection | SegmentSelectionRefusal {
  if (!project) return { ok: false, reason: "Open a project" };
  if (selection?.kind === "clip") {
    const ids = selectedClipIdsOf(selection);
    const wanted = new Set(ids);
    const clips = savedClips(project).filter((clip) => wanted.has(clip.id));
    if (!clips.length || clips.length !== wanted.size)
      return { ok: false, reason: "The selected clips changed" };
    return found(
      project,
      { clip_ids: [...wanted] },
      clips.length,
      Math.min(...clips.map((clip) => clip.timeline_start)),
      Math.max(...clips.map((clip) => clip.timeline_end)),
    );
  }
  if (selection?.kind !== "range" && selection?.kind !== "transcriptRange")
    return { ok: false, reason: NO_SEGMENT_SELECTION };
  const { targets, reason } = resolveSelectionRange(project, selection);
  const target = targets.length === 1 ? targets[0]! : null;
  if (!target) return { ok: false, reason: reason ?? NO_SEGMENT_SELECTION };
  if (target.intervals.length !== 1)
    return { ok: false, reason: "Select one stretch of time to save" };
  const { start, end } = target.intervals[0]!;
  if (!(end > start)) return { ok: false, reason: NO_SEGMENT_SELECTION };
  const held = new Set(target.track_ids);
  const inSpan = savedClips(project).filter(
    (clip) => clip.timeline_start < end && clip.timeline_end > start,
  );
  if (inSpan.some((clip) => !held.has(clip.track_id)))
    return {
      ok: false,
      reason:
        "A segment keeps every track. Select a timeline range across all tracks",
    };
  if (!inSpan.length)
    return { ok: false, reason: "There is no audio in that range" };
  return found(
    project,
    { time_range: `${secondsText(start)}-${secondsText(end)}` },
    inSpan.length,
    start,
    end,
  );
}
