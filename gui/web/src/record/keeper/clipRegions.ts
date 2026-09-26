import { KEEPER_SAMPLE_RATE } from "./pcm";

/** Hits closer together than this merge into one region. */
export const CLIP_REGION_MERGE_MS = 1000;
/** Per-segment cap; later hits that cannot merge into the last region are dropped and the segment is marked truncated. */
export const MAX_CLIP_REGIONS = 100;

const MERGE_SAMPLES = Math.round(
  (CLIP_REGION_MERGE_MS * KEEPER_SAMPLE_RATE) / 1000,
);
/**
 * Live consumers are re-notified when the open region grows by this much, so a
 * live end time can lag the real end by up to this long until the segment
 * closes. Anything that shows exact ends (e.g. a live timeline tint) must read
 * `regionsMs()` at segment close, not trust the last notification.
 */
export const CLIP_REGION_EMIT_STEP_MS = 250;
const EMIT_STEP_SAMPLES = Math.round(
  (CLIP_REGION_EMIT_STEP_MS * KEEPER_SAMPLE_RATE) / 1000,
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
  /** True when a segment hit MAX_CLIP_REGIONS and later clipping went unrecorded. */
  truncated?: boolean;
};

/** Merges hot sample spans (in segment samples) into bounded regions. */
export class ClipRegionTracker {
  private spans: { first: number; last: number }[] = [];
  private notifiedLast = -1;
  private capped = false;

  reset(): void {
    this.spans = [];
    this.notifiedLast = -1;
    this.capped = false;
  }

  /** True once a hit was dropped because the segment reached MAX_CLIP_REGIONS. */
  get truncated(): boolean {
    return this.capped;
  }

  /**
   * Record a hot run. Returns true when live consumers should re-read
   * `regionsMs()`: a region opened, the open region grew by at least
   * CLIP_REGION_EMIT_STEP_MS since the last true, or the cap was first hit.
   */
  observe(first: number, last: number): boolean {
    const tail = this.spans[this.spans.length - 1];
    if (tail && first - tail.last <= MERGE_SAMPLES) {
      tail.last = Math.max(tail.last, last);
      if (tail.last - this.notifiedLast < EMIT_STEP_SAMPLES) return false;
      this.notifiedLast = tail.last;
      return true;
    }
    if (this.spans.length >= MAX_CLIP_REGIONS) {
      if (this.capped) return false;
      this.capped = true;
      return true;
    }
    this.spans.push({ first, last });
    this.notifiedLast = last;
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
