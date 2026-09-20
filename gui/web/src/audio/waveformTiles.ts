import {
  FINEST_BINS_PER_SEC,
  OVERVIEW_BINS_PER_SEC,
  TILE_SEC,
  ZOOM_STEP,
} from "../utils/timelineZoom.generated";

export type WaveformTile = {
  key: string;
  projectPath: string;
  trackId: string;
  kind: string;
  mediaVersion: string;
  tileIndex: number;
  binsPerSec: number;
  startSec: number;
  endSec: number;
  peaks: Uint8Array;
};

export function snapBinsPerSec(desired: number): number {
  if (!(desired > 0)) {
    return OVERVIEW_BINS_PER_SEC;
  }
  if (desired <= OVERVIEW_BINS_PER_SEC) {
    return OVERVIEW_BINS_PER_SEC;
  }
  let rate = OVERVIEW_BINS_PER_SEC;
  while (
    rate * ZOOM_STEP <= desired + 1e-9 &&
    rate * ZOOM_STEP <= FINEST_BINS_PER_SEC
  ) {
    rate *= ZOOM_STEP;
  }
  return Math.min(FINEST_BINS_PER_SEC, rate);
}

export function tileIndexAt(sec: number, tileSec = TILE_SEC): number {
  return Math.floor(Math.max(0, sec) / tileSec);
}

export function tileRange(
  startSec: number,
  endSec: number,
  tileSec = TILE_SEC,
): number[] {
  const i0 = tileIndexAt(startSec, tileSec);
  const i1 = tileIndexAt(Math.max(startSec, endSec - 1e-9), tileSec);
  const out: number[] = [];
  for (let i = i0; i <= i1; i++) {
    out.push(i);
  }
  return out;
}

export function tileKey(
  projectPath: string,
  trackId: string,
  kind: string,
  mediaVersion: string,
  index: number,
  binsPerSec: number,
): string {
  return `${projectPath}|${trackId}|${kind}|${mediaVersion}|${index}|${binsPerSec}`;
}

export function coalesceIndices(indices: number[]): Array<[number, number]> {
  if (indices.length === 0) {
    return [];
  }
  const sorted = [...indices].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let lo = sorted[0] ?? 0;
  let hi = lo;
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i] ?? hi;
    if (v === hi + 1) {
      hi = v;
    } else {
      ranges.push([lo, hi]);
      lo = v;
      hi = v;
    }
  }
  ranges.push([lo, hi]);
  return ranges;
}

export class PeakTileLru {
  private map = new Map<string, WaveformTile>();
  private readonly max: number;

  constructor(max = 512) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): WaveformTile | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(tile: WaveformTile): void {
    if (this.map.has(tile.key)) {
      this.map.delete(tile.key);
    }
    this.map.set(tile.key, tile);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) {
        break;
      }
      this.map.delete(first);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }
}
