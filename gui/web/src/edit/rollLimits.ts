import type { ClipRow } from "../types/project";
import { MIN_EDGE_SPAN_SEC } from "./clipEdgePreview";
import { clipsAbut } from "./joinRender";
import { sameRecording } from "./recordingIdentity";

export interface RollJoinInterval {
  left: ClipRow;
  right: ClipRow;
  lo: number;
  hi: number;
}

/** Resolve one lane snapshot, mirroring `clips_ops.roll_join_limits`. */
export function rollJoinInterval(
  lane: readonly ClipRow[],
  leftClipId: string,
  rightClipId: string,
): RollJoinInterval | null {
  const clips = [...lane].sort((a, b) => a.timeline_start - b.timeline_start);
  const index = clips.findIndex((clip) => clip.id === leftClipId);
  const left = clips[index];
  const right = clips[index + 1];
  if (
    !left ||
    !right ||
    right.id !== rightClipId ||
    left.track_id !== right.track_id ||
    !clipsAbut(left, right)
  )
    return null;
  const prev = clips[index - 1];
  const next = clips[index + 2];
  const leftRoom =
    left.source_duration_sec == null
      ? 0
      : left.source_duration_sec - left.source_end;
  let maxPos = Math.min(
    leftRoom,
    right.source_end - right.source_start - MIN_EDGE_SPAN_SEC,
  );
  if (next && sameRecording(right, next))
    maxPos = Math.min(maxPos, next.source_start - right.source_start);
  const rightFloor = prev && sameRecording(right, prev) ? prev.source_end : 0;
  const maxNeg = Math.min(
    left.source_end - left.source_start - MIN_EDGE_SPAN_SEC,
    right.source_start - rightFloor,
  );
  return { left, right, lo: -Math.max(0, maxNeg), hi: Math.max(0, maxPos) };
}

export function clampToRollInterval(
  deltaSec: number,
  interval: RollJoinInterval,
): number {
  return Math.min(Math.max(deltaSec, interval.lo), interval.hi);
}
