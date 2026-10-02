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

type GroupIndex = {
  levels: number[];
  zooms: Map<number, { tileKeys: number[]; tiles: Map<number, Set<string>> }>;
};

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export class BitmapCache {
  private readonly lru: ByteLru<BitmapEntry>;
  private readonly groups = new Map<string, GroupIndex>();

  constructor(budget: () => number = () => waveformBudget().bitmapBytes) {
    this.lru = new ByteLru<BitmapEntry>(budget, (key, entry) => {
      this.unindex(key, entry);
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
    this.index(slot, entry);
    this.lru.set(slot, entry, entry.width * entry.height * 4);
  }

  /**
   * A stand-in for tile `tile` at `zoom` while its exact bitmap is pending:
   * the cached bitmap of the same group that overlaps it, at the nearest
   * zoom (ties go to the finer one).
   */
  placeholder(group: string, zoom: number, tile: number): Placeholder | null {
    const index = this.groups.get(group);
    if (!index) {
      return null;
    }
    const [t0, t1] = tileSeconds(tile, zoom);
    const levels = index.levels;
    let finer = lowerBound(levels, zoom);
    let coarser = finer - 1;
    while (coarser >= 0 || finer < levels.length) {
      const coarseZoom = levels[coarser];
      const fineZoom = levels[finer];
      const useFiner =
        coarser < 0 ||
        (finer < levels.length &&
          Math.abs(Math.log(fineZoom / zoom)) - 1e-9 <=
            Math.abs(Math.log(coarseZoom / zoom)));
      const level = useFiner ? fineZoom : coarseZoom;
      if (useFiner) {
        finer += 1;
      } else {
        coarser -= 1;
      }
      const { tileKeys, tiles } = index.zooms.get(level)!;
      const tileWidth = RENDER_TILE_CSS_PX / level;
      const start = Math.floor(t0 / tileWidth) - 1;
      const end = Math.ceil(t1 / tileWidth) + 1;
      for (
        let position = lowerBound(tileKeys, start);
        position < tileKeys.length && tileKeys[position] < end;
        position += 1
      ) {
        for (const key of tiles.get(tileKeys[position])!) {
          const entry = this.lru.peek(key)!;
          const [s0, s1] = tileSeconds(entry.tile, entry.zoom);
          if (s1 <= t0 || s0 >= t1) {
            continue;
          }
          this.lru.get(key);
          return { entry, startSec: s0, endSec: s1 };
        }
      }
    }
    return null;
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

  private index(key: string, entry: BitmapEntry): void {
    let group = this.groups.get(entry.group);
    if (!group) {
      group = { levels: [], zooms: new Map() };
      this.groups.set(entry.group, group);
    }
    let zoom = group.zooms.get(entry.zoom);
    if (!zoom) {
      zoom = { tileKeys: [], tiles: new Map() };
      group.zooms.set(entry.zoom, zoom);
      group.levels.splice(lowerBound(group.levels, entry.zoom), 0, entry.zoom);
    }
    let keys = zoom.tiles.get(entry.tile);
    if (!keys) {
      keys = new Set();
      zoom.tiles.set(entry.tile, keys);
      zoom.tileKeys.splice(
        lowerBound(zoom.tileKeys, entry.tile),
        0,
        entry.tile,
      );
    }
    keys.add(key);
  }

  private unindex(key: string, entry: BitmapEntry): void {
    const group = this.groups.get(entry.group)!;
    const zoom = group.zooms.get(entry.zoom)!;
    const keys = zoom.tiles.get(entry.tile)!;
    keys.delete(key);
    if (keys.size === 0) {
      zoom.tiles.delete(entry.tile);
      zoom.tileKeys.splice(lowerBound(zoom.tileKeys, entry.tile), 1);
    }
    if (zoom.tiles.size === 0) {
      group.zooms.delete(entry.zoom);
      group.levels.splice(lowerBound(group.levels, entry.zoom), 1);
    }
    if (group.levels.length === 0) {
      this.groups.delete(entry.group);
    }
  }
}

/** The shared cache of rendered waveform tiles. */
export const bitmapCache = new BitmapCache();
trimOnShellChange(bitmapCache);
