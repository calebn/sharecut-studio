import type { AppliedEditRecord, ClipRow } from "../types/project";
import { capitalize } from "../utils/format";
import { sourceSecInClipToTimeline } from "../utils/timebase";

/** Source-clock slack when matching a record's edge to a clip edge. */
export const APPLIED_EDGE_EPS_SEC = 1e-3;

export type AppliedTickKind = "seam" | "edge";

export interface AppliedTick {
  key: string;
  recordId: string;
  kind: AppliedTickKind;
  sec: number;
}

type AnchorSide = "end" | "start" | "inside";

interface Anchor {
  sourceSec: number;
  side: AnchorSide;
  /** Timeline second the record stored for this edge; breaks ties between clips sharing a source clock. */
  nearSec: number | null;
}

interface RecordAnchors {
  kind: AppliedTickKind;
  anchors: Anchor[];
  clipIds?: string[];
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

/** ``params.per_track_source[trackId]`` when present, else the record's own source span. */
export function sourcePairFor(
  record: AppliedEditRecord,
  trackId: string,
): [number, number] | null {
  const perTrack = record.params?.per_track_source;
  if (perTrack && typeof perTrack === "object") {
    const pair = (perTrack as Record<string, unknown>)[trackId];
    if (isNumberPair(pair)) {
      return [pair[0], pair[1]];
    }
  }
  if (record.source_start != null && record.source_end != null) {
    return [record.source_start, record.source_end];
  }
  return null;
}

/** ``params.split_source_by_track[trackId]``, the left clip's source_end at the split. */
export function splitSourceFor(
  record: AppliedEditRecord,
  trackId: string,
): number | null {
  const bySource = record.params?.split_source_by_track;
  if (bySource && typeof bySource === "object") {
    const value = (bySource as Record<string, unknown>)[trackId];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

function isMuteRecord(record: AppliedEditRecord): boolean {
  return record.params?.mute === true;
}

/** Seam anchors (left clip's end, right clip's start) for a removal record. */
function seamAnchors(
  record: AppliedEditRecord,
  trackId: string,
): RecordAnchors {
  const pair = sourcePairFor(record, trackId);
  if (!pair) return { kind: "seam", anchors: [] };
  return {
    kind: "seam",
    anchors: [
      { sourceSec: pair[0], side: "end", nearSec: record.timeline_start },
      { sourceSec: pair[1], side: "start", nearSec: record.timeline_end },
    ],
  };
}

/**
 * Source-clock anchors a record implies for one track, before projection through clips.
 *
 * Every ``operation`` the server writes to ``editorial.edit_log`` has its own ``case``;
 * ``tests/test_gui_readiness.py`` fails when a new one is added without one.
 */
export function recordAnchors(
  record: AppliedEditRecord,
  trackId: string,
): RecordAnchors {
  if (isMuteRecord(record)) {
    const pair = sourcePairFor(record, trackId);
    if (!pair) return { kind: "edge", anchors: [] };
    return {
      kind: "edge",
      anchors: [
        { sourceSec: pair[0], side: "inside", nearSec: record.timeline_start },
        { sourceSec: pair[1], side: "inside", nearSec: record.timeline_end },
      ],
    };
  }
  switch (record.operation) {
    case "trim_clip_edge": {
      const edge = record.params?.edge;
      if (edge === "in" && record.source_start != null) {
        return {
          kind: "edge",
          anchors: [
            {
              sourceSec: record.source_start,
              side: "start",
              nearSec: record.timeline_start,
            },
          ],
        };
      }
      if (edge === "out" && record.source_end != null) {
        return {
          kind: "edge",
          anchors: [
            {
              sourceSec: record.source_end,
              side: "end",
              nearSec: record.timeline_end,
            },
          ],
        };
      }
      return { kind: "edge", anchors: [] };
    }
    case "split_clips_at":
    case "approve_split": {
      const s = splitSourceFor(record, trackId);
      if (s == null) return { kind: "edge", anchors: [] };
      return {
        kind: "edge",
        anchors: [
          { sourceSec: s, side: "end", nearSec: record.timeline_start },
          { sourceSec: s, side: "start", nearSec: record.timeline_start },
        ],
      };
    }
    case "roll_clip_join": {
      if (record.source_start == null || record.source_end == null) {
        return { kind: "edge", anchors: [] };
      }
      return {
        kind: "edge",
        anchors: [
          {
            sourceSec: record.source_start,
            side: "end",
            nearSec: record.timeline_start,
          },
          {
            sourceSec: record.source_end,
            side: "start",
            nearSec: record.timeline_end,
          },
        ],
      };
    }
    case "move_clips": {
      const clips = record.params?.clips;
      const clipIds = Array.isArray(clips)
        ? clips
            .filter(
              (c): c is { clip_id: string; track_id: string } =>
                !!c &&
                typeof c === "object" &&
                (c as Record<string, unknown>).track_id === trackId &&
                typeof (c as Record<string, unknown>).clip_id === "string",
            )
            .map((c) => c.clip_id)
        : [];
      return { kind: "edge", anchors: [], clipIds };
    }
    case "ripple_delete":
    case "punch_delete":
    case "approve_edits":
    case "apply_prefix_edits":
      return seamAnchors(record, trackId);
    case "ripple_delete_clips":
    case "delete_clips":
      // Recorded by clip id with no source clocks: listed in Impact only.
      return { kind: "seam", anchors: [] };
    default:
      // Unknown or legacy operation: best effort from its source clocks.
      return seamAnchors(record, trackId);
  }
}

/** The item whose second is nearest `nearSec`; the first item when `nearSec` is null. */
function nearest<T>(
  items: readonly T[],
  secOf: (item: T) => number,
  nearSec: number | null,
): T | null {
  if (items.length === 0) return null;
  if (nearSec == null) return items[0];
  let best = items[0];
  for (const item of items) {
    if (Math.abs(secOf(item) - nearSec) < Math.abs(secOf(best) - nearSec)) {
      best = item;
    }
  }
  return best;
}

/** Timeline second an anchor maps to via `clips`, or null when it no longer matches any clip. */
export function anchorToTimeline(
  anchor: Anchor,
  clips: readonly ClipRow[],
): number | null {
  if (anchor.side === "end") {
    const hits = clips.filter(
      (c) => Math.abs(c.source_end - anchor.sourceSec) <= APPLIED_EDGE_EPS_SEC,
    );
    return (
      nearest(hits, (c) => c.timeline_end, anchor.nearSec)?.timeline_end ?? null
    );
  }
  if (anchor.side === "start") {
    const hits = clips.filter(
      (c) =>
        Math.abs(c.source_start - anchor.sourceSec) <= APPLIED_EDGE_EPS_SEC,
    );
    return (
      nearest(hits, (c) => c.timeline_start, anchor.nearSec)?.timeline_start ??
      null
    );
  }
  const secs: number[] = [];
  for (const clip of clips) {
    const t = sourceSecInClipToTimeline(clip, anchor.sourceSec);
    if (t != null) {
      secs.push(t);
    }
  }
  return nearest(secs, (t) => t, anchor.nearSec);
}

/**
 * Timeline seconds of the join an `end` → `start` anchor pair describes: a clip whose
 * source_end matches `end`, immediately followed in timeline order by a clip whose
 * source_start matches `start`. Prefers that adjacent pair over matching each edge on
 * its own, so duplicated material elsewhere cannot capture the tick.
 */
export function seamPairToTimeline(
  end: Anchor,
  start: Anchor,
  clips: readonly ClipRow[],
): [number, number] | null {
  const ordered = [...clips].sort(
    (a, b) => a.timeline_start - b.timeline_start,
  );
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const left = ordered[i];
    const right = ordered[i + 1];
    if (
      Math.abs(left.source_end - end.sourceSec) <= APPLIED_EDGE_EPS_SEC &&
      Math.abs(right.source_start - start.sourceSec) <= APPLIED_EDGE_EPS_SEC
    ) {
      pairs.push([left.timeline_end, right.timeline_start]);
    }
  }
  return nearest(pairs, (p) => p[0], end.nearSec);
}

const OPERATION_LABELS: Record<string, string> = {
  ripple_delete: "Ripple delete",
  punch_delete: "Punch delete",
  ripple_delete_clips: "Ripple delete clips",
  delete_clips: "Delete clips",
  trim_clip_edge: "Trim",
  split_clips_at: "Split",
  approve_split: "Split",
  roll_clip_join: "Roll join",
  move_clips: "Move",
};

/** Human title for a record, e.g. "Ripple delete", "Cut: filler:um", "Mute". */
export function appliedEditTitle(record: AppliedEditRecord): string {
  let label: string;
  if (isMuteRecord(record)) {
    label = "Mute";
  } else if (record.operation in OPERATION_LABELS) {
    label = OPERATION_LABELS[record.operation];
  } else if (
    record.operation === "approve_edits" ||
    record.operation === "apply_prefix_edits"
  ) {
    label = "Cut";
  } else {
    label = capitalize(record.operation.replaceAll("_", " "));
  }
  const reason = record.reason?.trim();
  return reason ? `${label}: ${reason}` : label;
}

/** Timeline seconds one record projects to on a track, before de-duplication. */
function recordSecs(
  record: AppliedEditRecord,
  trackId: string,
  clips: readonly ClipRow[],
): { kind: AppliedTickKind; secs: number[] } {
  const { kind, anchors, clipIds } = recordAnchors(record, trackId);
  const [first, second] = anchors;
  const pair =
    anchors.length === 2 && first.side === "end" && second.side === "start"
      ? seamPairToTimeline(first, second, clips)
      : null;
  const secs: number[] = pair ? [...pair] : [];
  if (!pair) {
    for (const anchor of anchors) {
      const sec = anchorToTimeline(anchor, clips);
      if (sec != null) {
        secs.push(sec);
      }
    }
  }
  for (const clipId of clipIds ?? []) {
    const clip = clips.find((c) => c.id === clipId);
    if (clip) {
      secs.push(clip.timeline_start);
    }
  }
  return { kind, secs };
}

/** Ticks for one track's lane, projected through its current clips. */
export function appliedEditTicks(
  records: readonly AppliedEditRecord[],
  trackId: string,
  clips: readonly ClipRow[],
): AppliedTick[] {
  const out: AppliedTick[] = [];
  for (const record of records) {
    if (!record.track_ids.includes(trackId)) {
      continue;
    }
    const { kind, secs } = recordSecs(record, trackId, clips);
    // De-dup by position alone: every anchor of a record shares its one `kind`.
    // An operation that mixes seam and edge anchors must key this on (kind, sec).
    const deduped: number[] = [];
    for (const sec of secs) {
      if (!deduped.some((s) => Math.abs(s - sec) <= APPLIED_EDGE_EPS_SEC)) {
        deduped.push(sec);
      }
    }
    deduped.forEach((sec, i) => {
      out.push({ key: `${record.id}:${i}`, recordId: record.id, kind, sec });
    });
  }
  return out;
}

/** Whether a record maps to any tick on any of its tracks against the current clips. */
export function appliedRecordOnTimeline(
  record: AppliedEditRecord,
  clipsByTrack: Record<string, ClipRow[]>,
): boolean {
  return record.track_ids.some(
    (trackId) =>
      appliedEditTicks([record], trackId, clipsByTrack[trackId] ?? []).length >
      0,
  );
}
