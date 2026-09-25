import { RENDER_TILE_CSS_PX } from "../utils/timelineZoom.generated";
import { ByteLru, trimOnShellChange, waveformBudget } from "./budgets";

/**
 * Rendered tile bitmaps (S5, S8): an LRU by bytes that `close()`s every
 * bitmap it evicts. Exact hits are keyed by the full tile key. Provisional
 * bitmaps (rendered from a coarser level while the exact bins load) are
 * stored beside them but never returned as an exact hit; both kinds serve as
 * placeholders.
 */

export type BitmapEntry = {
  bitmap: ImageBitmap;
  /** Device px. */
  width: number;
  height: number;
  /** `mediaKey|styleKey|heightDev|d|ampZoom`: what must match to stand in. */
  group: string;
  zoom: number;
  /** Render tile index `k`. */
  tile: number;
  provisional: boolean;
};

export type Placeholder = {
  entry: BitmapEntry;
  /** Media seconds the bitmap covers. */
  startSec: number;
  endSec: number;
};

/** Media seconds `[start, end)` render tile `k` covers at `zoom`. */
export function tileSeconds(tile: number, zoom: number): [number, number] {
  return [
    (tile * RENDER_TILE_CSS_PX) / zoom,
    ((tile + 1) * RENDER_TILE_CSS_PX) / zoom,
  ];
}

const PROVISIONAL = "\u0000provisional";

export class BitmapCache {
  private readonly lru: ByteLru<BitmapEntry>;
  private readonly groups = new Map<string, Set<string>>();

  constructor(budget: () => number = () => waveformBudget().bitmapBytes) {
    this.lru = new ByteLru<BitmapEntry>(budget, (key, entry) => {
      this.unindex(key, entry.group);
      entry.bitmap.close();
    });
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  get size(): number {
    return this.lru.size;
  }

  /** The exact bitmap for `key`; provisional renders never match. */
  get(key: string): BitmapEntry | undefined {
    return this.lru.get(key);
  }

  /** Whether `entry` is still cached under `key` (an insert over budget evicts it at once). */
  holds(key: string, entry: BitmapEntry): boolean {
    return this.lru.peek(entry.provisional ? key + PROVISIONAL : key) === entry;
  }

  /** True while a provisional stand-in for `key` is cached. */
  hasProvisional(key: string): boolean {
    return this.lru.has(key + PROVISIONAL);
  }

  set(key: string, entry: BitmapEntry): void {
    const slot = entry.provisional ? key + PROVISIONAL : key;
    if (!entry.provisional) {
      // The exact render supersedes the stand-in.
      this.lru.delete(key + PROVISIONAL);
    }
    // Drop (close and unindex) any old entry first, so it cannot unindex the new one.
    this.lru.delete(slot);
    let keys = this.groups.get(entry.group);
    if (!keys) {
      keys = new Set();
      this.groups.set(entry.group, keys);
    }
    // Index before insert: inserting may evict (and unindex) at once.
    keys.add(slot);
    this.lru.set(slot, entry, entry.width * entry.height * 4);
  }

  /**
   * A stand-in for tile `tile` at `zoom` while its exact bitmap is pending:
   * the cached bitmap of the same group that overlaps it, at the nearest
   * zoom (ties go to the finer one).
   */
  placeholder(group: string, zoom: number, tile: number): Placeholder | null {
    const keys = this.groups.get(group);
    if (!keys) {
      return null;
    }
    const [t0, t1] = tileSeconds(tile, zoom);
    let best: Placeholder | null = null;
    let bestKey = "";
    let bestScore = Number.POSITIVE_INFINITY;
    for (const key of keys) {
      const entry = this.lru.peek(key);
      if (!entry) {
        continue;
      }
      const [s0, s1] = tileSeconds(entry.tile, entry.zoom);
      if (s1 <= t0 || s0 >= t1) {
        continue;
      }
      const score =
        Math.abs(Math.log(entry.zoom / zoom)) - (entry.zoom >= zoom ? 1e-9 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
        best = { entry, startSec: s0, endSec: s1 };
      }
    }
    if (best) {
      // Mark it used so an on-screen stand-in is not evicted first.
      this.lru.get(bestKey);
    }
    return best;
  }

  delete(key: string): void {
    this.lru.delete(key);
    this.lru.delete(key + PROVISIONAL);
  }

  clear(): void {
    this.lru.clear();
    this.groups.clear();
  }

  /** Re-apply the budget (budgets.ts calls it on a shell change). */
  trim(): void {
    this.lru.trim();
  }

  private unindex(key: string, group: string): void {
    const keys = this.groups.get(group);
    keys?.delete(key);
    if (keys && keys.size === 0) {
      this.groups.delete(group);
    }
  }
}

/** The shared cache of rendered waveform tiles. */
export const bitmapCache = new BitmapCache();
trimOnShellChange(bitmapCache);
