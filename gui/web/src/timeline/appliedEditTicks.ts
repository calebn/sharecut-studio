import type { AppliedEditRecord, ClipRow } from "../types/project";
import { sourceSecInClipToTimeline } from "../utils/timebase";

/** Source-clock slack when matching a record's edge to a clip edge. */
export const APPLIED_EDGE_EPS_SEC = 1e-3;

export type AppliedTickKind = "seam" | "edge";

export interface AppliedTick {
  key: string;
  recordId: string;
  kind: AppliedTickKind;
  sec: number;
  title: string;
}

type AnchorSide = "end" | "start" | "inside";

interface Anchor {
  sourceSec: number;
  side: AnchorSide;
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

/** Source-clock anchors a record implies for one track, before projection through clips. */
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
        { sourceSec: pair[0], side: "inside" },
        { sourceSec: pair[1], side: "inside" },
      ],
    };
  }
  switch (record.operation) {
    case "trim_clip_edge": {
      const edge = record.params?.edge;
      if (edge === "in" && record.source_start != null) {
        return {
          kind: "edge",
          anchors: [{ sourceSec: record.source_start, side: "start" }],
        };
      }
      if (edge === "out" && record.source_end != null) {
        return {
          kind: "edge",
          anchors: [{ sourceSec: record.source_end, side: "end" }],
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
          { sourceSec: s, side: "end" },
          { sourceSec: s, side: "start" },
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
          { sourceSec: record.source_start, side: "end" },
          { sourceSec: record.source_end, side: "start" },
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
    default: {
      // Removals: ripple_delete, punch_delete, approve_edits, apply_prefix_edits, etc.
      const pair = sourcePairFor(record, trackId);
      if (!pair) return { kind: "seam", anchors: [] };
      return {
        kind: "seam",
        anchors: [
          { sourceSec: pair[0], side: "end" },
          { sourceSec: pair[1], side: "start" },
        ],
      };
    }
  }
}

/** Timeline second an anchor maps to via `clips`, or null when it no longer matches any clip. */
export function anchorToTimeline(
  anchor: Anchor,
  clips: readonly ClipRow[],
): number | null {
  if (anchor.side === "end") {
    const clip = clips.find(
      (c) => Math.abs(c.source_end - anchor.sourceSec) <= APPLIED_EDGE_EPS_SEC,
    );
    return clip ? clip.timeline_end : null;
  }
  if (anchor.side === "start") {
    const clip = clips.find(
      (c) =>
        Math.abs(c.source_start - anchor.sourceSec) <= APPLIED_EDGE_EPS_SEC,
    );
    return clip ? clip.timeline_start : null;
  }
  for (const clip of clips) {
    const t = sourceSecInClipToTimeline(clip, anchor.sourceSec);
    if (t != null) {
      return t;
    }
  }
  return null;
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

function humanize(operation: string): string {
  const words = operation.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human title for a tick, e.g. "Ripple delete", "Cut: filler:um", "Mute". */
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
    label = humanize(record.operation);
  }
  const reason = record.reason?.trim();
  return reason ? `${label}: ${reason}` : label;
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
    const { kind, anchors, clipIds } = recordAnchors(record, trackId);
    const secs: number[] = [];
    for (const anchor of anchors) {
      const sec = anchorToTimeline(anchor, clips);
      if (sec != null) {
        secs.push(sec);
      }
    }
    for (const clipId of clipIds ?? []) {
      const clip = clips.find((c) => c.id === clipId);
      if (clip) {
        secs.push(clip.timeline_start);
      }
    }
    const deduped: number[] = [];
    for (const sec of secs) {
      if (!deduped.some((s) => Math.abs(s - sec) <= APPLIED_EDGE_EPS_SEC)) {
        deduped.push(sec);
      }
    }
    const title = appliedEditTitle(record);
    deduped.forEach((sec, i) => {
      out.push({
        key: `${record.id}:${i}`,
        recordId: record.id,
        kind,
        sec,
        title,
      });
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
