import { KEEPER_SAMPLE_RATE } from "./pcm";

/** Hits closer together than this merge into one region. */
export const CLIP_REGION_MERGE_MS = 1000;
/** Per-segment cap; further hits extend the last region. */
export const MAX_CLIP_REGIONS = 100;

const MERGE_SAMPLES = Math.round(
  (CLIP_REGION_MERGE_MS * KEEPER_SAMPLE_RATE) / 1000,
);

/** Segment-relative clipping span in milliseconds. */
export type KeeperClipRegion = { startMs: number; endMs: number };

/** A clipping span placed in its take (and still segment-relative for jumps). */
export type TakeClipRegion = {
  segmentIndex: number;
  /** Take-relative start/end (segment join offset applied). */
  startMs: number;
  endMs: number;
  /** Segment-relative start, which equals the landed source's seconds. */
  segmentStartMs: number;
};

export type TakeClipping = {
  takeIndex: number;
  regions: TakeClipRegion[];
  /** True when every segment is known to have been checked for clipping. */
  known: boolean;
};

/** Merges hot sample spans (in segment samples) into bounded regions. */
export class ClipRegionTracker {
  private spans: { first: number; last: number }[] = [];

  reset(): void {
    this.spans = [];
  }

  /** Record a hot run; returns true when it opened a new region. */
  observe(first: number, last: number): boolean {
    const tail = this.spans[this.spans.length - 1];
    if (
      tail &&
      (first - tail.last <= MERGE_SAMPLES ||
        this.spans.length >= MAX_CLIP_REGIONS)
    ) {
      tail.last = Math.max(tail.last, last);
      return false;
    }
    this.spans.push({ first, last });
    return true;
  }

  regionsMs(): KeeperClipRegion[] {
    return this.spans.map((span) => {
      const startMs = Math.floor((span.first * 1000) / KEEPER_SAMPLE_RATE);
      const endMs = Math.ceil(((span.last + 1) * 1000) / KEEPER_SAMPLE_RATE);
      return { startMs, endMs: Math.max(endMs, startMs + 1) };
    });
  }
}

export function serializeClipRegions(regions: KeeperClipRegion[]): string {
  return regions.map((r) => `${r.startMs}-${r.endMs}`).join(",");
}

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validate untrusted regions; null when malformed. */
export function parseClipRegions(value: unknown): KeeperClipRegion[] | null {
  if (!Array.isArray(value) || value.length > MAX_CLIP_REGIONS) return null;
  const out: KeeperClipRegion[] = [];
  let prevEnd = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { startMs, endMs } = item as Record<string, unknown>;
    if (!isMs(startMs) || !isMs(endMs) || startMs >= endMs) return null;
    if (startMs < prevEnd) return null;
    out.push({ startMs, endMs });
    prevEnd = endMs;
  }
  return out;
}

/** Shift segment-relative regions into take time. */
export function takeRelativeMs(
  segmentIndex: number,
  joinOffsetMs: number,
  regions: KeeperClipRegion[],
): TakeClipRegion[] {
  return regions.map((r) => ({
    segmentIndex,
    startMs: r.startMs + joinOffsetMs,
    endMs: r.endMs + joinOffsetMs,
    segmentStartMs: r.startMs,
  }));
}
