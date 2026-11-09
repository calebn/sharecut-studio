import {
  APPLIED_EDGE_EPS_SEC,
  recordAnchors,
  SEAM_MATCH_SEC,
  sourcePairFor,
} from "../timeline/appliedEditTicks";
import type {
  AppliedEditRecord,
  ClipRow,
  EditBoundaryView,
  ProjectView,
} from "../types/project";
import { isRemovalRecord } from "../utils/appliedRecords";
import { formatRulerTime } from "../utils/time";
import { rollJoinInterval } from "./rollLimits";

export type SeamId = `eb:${string}:${string}`;

type SeamBase = {
  id: SeamId;
  trackId: string;
  left: ClipRow;
  right: ClipRow;
  joinSec: number;
  abuts: boolean;
};

export type Seam =
  | (SeamBase & { kind: "split" })
  | (SeamBase & {
      kind: "cut";
      removedSec: number;
      records: readonly AppliedEditRecord[];
    });

export type CutSeam = Extract<Seam, { kind: "cut" }>;

export type KeepPlan =
  | { kind: "restore"; ids: readonly [string, ...string[]]; trackCount: number }
  | { kind: "disabled"; reason: string; openHistory: boolean };

export const UNDO_IN_HISTORY = "Undo this in History";

export function seamIdOf(left: { id: string }, right: { id: string }): SeamId {
  return `eb:${left.id}:${right.id}`;
}

function overlapSec(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

function recordSecs(record: AppliedEditRecord, trackId: string): number[] {
  const { timelineSecs } = recordAnchors(record, trackId);
  if (timelineSecs && timelineSecs.length > 0) return timelineSecs;
  return [record.timeline_start, record.timeline_end].filter(
    (sec): sec is number => sec != null,
  );
}

function nearestSeam<T extends { joinSec: number }>(
  seams: readonly T[],
  sec: number | null,
): T | null {
  let best: T | null = null;
  for (const seam of seams) {
    if (
      best === null ||
      (sec != null &&
        Math.abs(seam.joinSec - sec) < Math.abs(best.joinSec - sec))
    ) {
      best = seam;
    }
  }
  return best;
}

type Draft = {
  boundary: EditBoundaryView;
  base: SeamBase;
  records: AppliedEditRecord[];
};

function assignRecords(
  drafts: readonly Draft[],
  records: readonly AppliedEditRecord[],
  trackId: string,
): void {
  for (const record of records) {
    if (!record.track_ids.includes(trackId) || !isRemovalRecord(record)) {
      continue;
    }
    const pair = sourcePairFor(record, trackId);
    let target: Draft | null = null;
    if (pair) {
      const overlapping = drafts
        .filter(
          (draft) =>
            draft.boundary.has_cutaway &&
            overlapSec(pair, [
              draft.boundary.cutaway_source_start,
              draft.boundary.cutaway_source_end,
            ]) > APPLIED_EDGE_EPS_SEC,
        )
        .map((draft) => ({ draft, joinSec: draft.base.joinSec }));
      target = nearestSeam(overlapping, record.timeline_start)?.draft ?? null;
    } else {
      let bestGap = SEAM_MATCH_SEC;
      for (const draft of drafts) {
        for (const sec of recordSecs(record, trackId)) {
          const gap = Math.abs(draft.base.joinSec - sec);
          if (gap <= bestGap) {
            bestGap = gap;
            target = draft;
          }
        }
      }
    }
    target?.records.push(record);
  }
}

function removedSecOf(draft: Draft): number {
  const { boundary, records } = draft;
  if (boundary.has_cutaway) {
    return boundary.cutaway_source_end - boundary.cutaway_source_start;
  }
  let longest = 0;
  for (const record of records) {
    const pair = sourcePairFor(record, boundary.track_id);
    if (pair) longest = Math.max(longest, pair[1] - pair[0]);
  }
  return longest;
}

function build(
  boundaries: readonly EditBoundaryView[],
  records: readonly AppliedEditRecord[],
  lane: readonly ClipRow[],
  trackId: string,
): Seam[] {
  const drafts: Draft[] = [];
  for (const boundary of boundaries) {
    if (boundary.track_id !== trackId || boundary.right_clip_id == null) {
      continue;
    }
    const left = lane.find((clip) => clip.id === boundary.left_clip_id);
    const right = lane.find((clip) => clip.id === boundary.right_clip_id);
    if (!left || !right) continue;
    drafts.push({
      boundary,
      records: [],
      base: {
        id: seamIdOf(left, right),
        trackId,
        left,
        right,
        joinSec: left.timeline_end,
        abuts: rollJoinInterval(lane, left.id, right.id) !== null,
      },
    });
  }
  assignRecords(drafts, records, trackId);
  return drafts.map((draft): Seam => {
    if (!draft.boundary.has_cutaway && draft.records.length === 0) {
      return { ...draft.base, kind: "split" };
    }
    return {
      ...draft.base,
      kind: "cut",
      removedSec: removedSecOf(draft),
      records: draft.records,
    };
  });
}

type Cached = {
  boundaries: readonly EditBoundaryView[];
  records: readonly AppliedEditRecord[];
  seams: readonly Seam[];
};

const cache = new WeakMap<readonly ClipRow[], Cached>();

export function seamsOnTrack(
  project: ProjectView,
  trackId: string,
): readonly Seam[] {
  const lane = project.clips.tracks[trackId];
  if (!lane) return [];
  const boundaries = project.edit_boundaries ?? [];
  const records = project.applied_edits.records;
  const hit = cache.get(lane);
  if (hit && hit.boundaries === boundaries && hit.records === records) {
    return hit.seams;
  }
  const seams = build(boundaries, records, lane, trackId);
  cache.set(lane, { boundaries, records, seams });
  return seams;
}

export function seamById(project: ProjectView, id: string): Seam | null {
  const boundary = project.edit_boundaries?.find((row) => row.id === id);
  if (!boundary) return null;
  return (
    seamsOnTrack(project, boundary.track_id).find((seam) => seam.id === id) ??
    null
  );
}

export function keepPlan(seam: CutSeam): KeepPlan {
  const { records } = seam;
  if (
    records.length === 0 ||
    records.some((record) => record.restore.state === "history_only")
  ) {
    return { kind: "disabled", reason: UNDO_IN_HISTORY, openHistory: true };
  }
  const ids = records.map((record) => record.id);
  for (const record of records) {
    if (
      record.restore.state === "blocked" &&
      !record.restore.blocked_by.every((id) => ids.includes(id))
    ) {
      return {
        kind: "disabled",
        reason: record.restore.message,
        openHistory: false,
      };
    }
  }
  const trackIds = new Set(records.flatMap((record) => record.track_ids));
  return {
    kind: "restore",
    ids: ids as [string, ...string[]],
    trackCount: trackIds.size,
  };
}

export function seamTitle(seam: Seam): string {
  if (seam.kind === "split") {
    return `Split at ${formatRulerTime(seam.joinSec, 0.1)}`;
  }
  const length =
    seam.removedSec > 0 ? `${seam.removedSec.toFixed(1)} s cut` : "Cut";
  const reason = seam.records[0]?.reason?.trim();
  return reason ? `${length} · ${reason}` : length;
}
