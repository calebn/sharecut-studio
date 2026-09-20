import type { ClipRow } from "../types/project";
import { originTrackId } from "../utils/timebase";

export function chunkIndexForSource(srcSec: number, chunkSec: number): number {
  if (chunkSec <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(srcSec / chunkSec));
}

export function chunkFileStartSec(
  idx: number,
  chunkSec: number,
  overlapMs: number,
): number {
  const overlap = overlapMs / 1000;
  const nominal = idx * chunkSec;
  return Math.max(0, nominal - (idx === 0 ? 0 : overlap));
}

export function offsetInChunk(
  srcSec: number,
  idx: number,
  chunkSec: number,
  overlapMs: number,
): number {
  return Math.max(0, srcSec - chunkFileStartSec(idx, chunkSec, overlapMs));
}

export type GainCurve = "linear" | "equalPower";

export interface ScheduledSlice {
  trackId: string;
  chunkIdx: number;
  bufferOffsetSec: number;
  durationSec: number;
  whenTimelineSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  gainCurve: GainCurve;
}

function clipSlices(
  clip: ClipRow,
  chunkSec: number,
  overlapMs: number,
): ScheduledSlice[] {
  const slices: ScheduledSlice[] = [];
  const srcDur = Math.max(0, clip.source_end - clip.source_start);
  if (srcDur <= 0) {
    return slices;
  }
  let srcCursor = clip.source_start;
  let timelineCursor = clip.timeline_start;
  const fadeInSec = Math.max(0, clip.fade_in_ms) / 1000;
  const fadeOutSec = Math.max(0, clip.fade_out_ms) / 1000;
  const equalPower = clip.join_in_mode === "crossfade";
  const firstIdx = chunkIndexForSource(clip.source_start, chunkSec);
  const lastIdx = chunkIndexForSource(
    Math.max(clip.source_start, clip.source_end - 1e-9),
    chunkSec,
  );

  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const chunkStart = idx * chunkSec;
    const chunkEnd = chunkStart + chunkSec;
    const srcStart = Math.max(srcCursor, chunkStart);
    const srcEnd = Math.min(clip.source_end, chunkEnd);
    if (srcEnd <= srcStart) {
      continue;
    }
    const dur = srcEnd - srcStart;
    const isFirst = srcStart <= clip.source_start + 1e-9;
    const isLast = srcEnd >= clip.source_end - 1e-9;
    slices.push({
      trackId: originTrackId(clip),
      chunkIdx: idx,
      bufferOffsetSec: offsetInChunk(srcStart, idx, chunkSec, overlapMs),
      durationSec: dur,
      whenTimelineSec: timelineCursor,
      fadeInSec: isFirst ? fadeInSec : 0,
      fadeOutSec: isLast ? fadeOutSec : 0,
      gainCurve: equalPower && isFirst ? "equalPower" : "linear",
    });
    srcCursor = srcEnd;
    timelineCursor += dur;
  }
  return slices;
}

/** Build scheduled slices for clips overlapping [windowStart, windowEnd) on the timeline. */
export function buildSchedule(
  clips: ClipRow[],
  windowStartSec: number,
  windowEndSec: number,
  chunkSec: number,
  overlapMs: number,
): ScheduledSlice[] {
  const out: ScheduledSlice[] = [];
  for (const clip of clips) {
    if (
      clip.timeline_end <= windowStartSec ||
      clip.timeline_start >= windowEndSec
    ) {
      continue;
    }
    for (const slice of clipSlices(clip, chunkSec, overlapMs)) {
      const sliceEnd = slice.whenTimelineSec + slice.durationSec;
      if (sliceEnd <= windowStartSec || slice.whenTimelineSec >= windowEndSec) {
        continue;
      }
      out.push(slice);
    }
  }
  return out;
}

export interface ProxyTrackManifest {
  hash: string;
  chunk_sec: number;
  overlap_ms: number;
  chunk_count: number;
  duration_sec: number;
  urls: string[];
}

export interface ProxyManifest {
  tracks: Record<string, ProxyTrackManifest>;
}
