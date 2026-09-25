import { loadWaveformTiles } from "../api";
import { MAX_TILES_PER_REQUEST } from "../utils/timelineZoom.generated";
import {
  ByteLru,
  classifyFetchFailure,
  FAILED_FETCH_BACKOFF_MS,
  fetchLimit,
  waveformBudget,
  waveformFetchGate,
} from "./budgets";
import { BIN_VALUES, levelTileCount, tileBinCount } from "./pyramidMath";
import { noteWaveformTileMissing, onWaveformReady } from "./statusStore";
import type { PyramidMeta } from "./types";

/**
 * Pyramid data tiles (S8 budget). Missing tiles queue by priority (visible,
 * overscan, prefetch), coalesce into runs of up to `max_tiles_per_request`
 * and share the waveform fetch gate. Zoom and scroll never abort a fetch:
 * whatever arrives is cached. Only leaving the project aborts.
 */

export const PRIORITY_VISIBLE = 0;
export const PRIORITY_OVERSCAN = 1;
export const PRIORITY_PREFETCH = 2;
export type TilePriority =
  | typeof PRIORITY_VISIBLE
  | typeof PRIORITY_OVERSCAN
  | typeof PRIORITY_PREFETCH;

/** Levels finer than the coarsest are prefetched only up to this many tiles. */
const PREFETCH_MAX_TILES = 8;

type Source = { projectPath: string; ref: string; meta: PyramidMeta };

type Pending = Source & { level: number; tile: number; priority: TilePriority };

const data = new ByteLru<Int16Array>(() => waveformBudget().tileBytes);
const pending = new Map<string, Pending>();
const inflight = new Set<string>();
const requests = new Set<{
  projectPath: string;
  controller: AbortController;
}>();
const retries = new Set<{
  projectPath: string;
  ids: string[];
  timer: ReturnType<typeof setTimeout>;
}>();
/** Tile ids held back after a failed fetch (a 429 until Retry-After, otherwise FAILED_FETCH_BACKOFF_MS). */
const cooling = new Set<string>();
/** Tile ids that 404'd or came back short under their key; skipped until the key is ready again. */
const missing = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function tileId(key: string, level: number, tile: number): string {
  return `${key}|${level}|${tile}`;
}

function notify(key: string): void {
  for (const fn of [...(listeners.get(key) ?? [])]) {
    fn();
  }
}

/** Called when tiles of pyramid `key` arrive. */
export function subscribePyramid(
  key: string,
  listener: () => void,
): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(key);
    }
  };
}

export function hasTile(key: string, level: number, tile: number): boolean {
  return data.has(tileId(key, level, tile));
}

/** Queue the missing tiles of one level; already loaded or queued ones are skipped. */
export function requestTiles(
  source: Source,
  level: number,
  tiles: Iterable<number>,
  priority: TilePriority,
): void {
  const count = levelTileCount(source.meta, level);
  for (const tile of tiles) {
    if (tile < 0 || tile >= count) {
      continue;
    }
    const id = tileId(source.meta.key, level, tile);
    if (
      data.has(id) ||
      inflight.has(id) ||
      cooling.has(id) ||
      missing.has(id)
    ) {
      continue;
    }
    const queued = pending.get(id);
    if (queued) {
      queued.priority = Math.min(queued.priority, priority) as TilePriority;
      // The latest requester owns the tile, so leaving the other project keeps it.
      queued.projectPath = source.projectPath;
      queued.ref = source.ref;
      continue;
    }
    pending.set(id, { ...source, level, tile, priority });
  }
  pump();
}

/** The most urgent queued tile (lowest priority value, then oldest). */
function nextPending(): Pending | null {
  let best: Pending | null = null;
  for (const p of pending.values()) {
    if (!best || p.priority < best.priority) {
      best = p;
    }
  }
  return best;
}

/** A run of queued, consecutive tiles of `head`'s level around it. */
function runAround(head: Pending): Pending[] {
  const { key } = head.meta;
  let start = head.tile;
  while (
    head.tile - start + 1 < MAX_TILES_PER_REQUEST &&
    pending.has(tileId(key, head.level, start - 1))
  ) {
    start -= 1;
  }
  const run: Pending[] = [];
  for (
    let t = start;
    run.length < MAX_TILES_PER_REQUEST &&
    pending.has(tileId(key, head.level, t));
    t++
  ) {
    run.push(pending.get(tileId(key, head.level, t))!);
  }
  return run;
}

function pump(): void {
  for (;;) {
    const head = nextPending();
    if (!head || !waveformFetchGate.tryAcquire(fetchLimit(head.projectPath))) {
      return;
    }
    dispatch(runAround(head));
  }
}

// Tiles and PCM share the gate: a slot either store frees wakes both.
waveformFetchGate.onRelease(pump);

function store(run: Pending[], buf: ArrayBuffer): void {
  const head = run[0]!;
  const all = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
  let offset = 0;
  let short = false;
  for (const p of run) {
    const id = tileId(p.meta.key, p.level, p.tile);
    const n = tileBinCount(p.meta, p.level, p.tile) * BIN_VALUES;
    if (short || offset + n > all.length) {
      // Fewer tiles came back than were asked for: treat the rest like a 404.
      short = true;
      missing.add(id);
      continue;
    }
    const bins = all.slice(offset, offset + n);
    offset += n;
    data.set(id, bins, bins.byteLength);
  }
  notify(head.meta.key);
  if (short) {
    noteWaveformTileMissing(head.projectPath, head.ref, head.meta.key);
  }
}

function dispatch(run: Pending[]): void {
  const head = run[0]!;
  const ids = run.map((p) => tileId(p.meta.key, p.level, p.tile));
  for (const id of ids) {
    pending.delete(id);
    inflight.add(id);
  }
  const request = {
    projectPath: head.projectPath,
    controller: new AbortController(),
  };
  requests.add(request);
  loadWaveformTiles(
    head.projectPath,
    {
      key: head.meta.key,
      ref: head.ref,
      level: head.level,
      start: head.tile,
      count: run.length,
    },
    request.controller.signal,
  )
    .then((buf) => {
      if (!request.controller.signal.aborted) {
        store(run, buf);
      }
    })
    .catch((err: unknown) => {
      if (request.controller.signal.aborted) {
        return;
      }
      const failure = classifyFetchFailure(err);
      if (failure.kind === "missing") {
        for (const id of ids) {
          missing.add(id);
        }
        noteWaveformTileMissing(head.projectPath, head.ref, head.meta.key);
        return;
      }
      // Hold the run back: a 429 until Retry-After (then re-queue it), anything else briefly.
      for (const id of ids) {
        cooling.add(id);
      }
      const retry = {
        projectPath: head.projectPath,
        ids,
        timer: setTimeout(
          () => {
            retries.delete(retry);
            for (const id of ids) {
              cooling.delete(id);
            }
            if (failure.kind === "retry") {
              for (const p of run) {
                const id = tileId(p.meta.key, p.level, p.tile);
                if (!data.has(id) && !inflight.has(id) && !pending.has(id)) {
                  pending.set(id, p);
                }
              }
            }
            pump();
          },
          failure.kind === "retry" ? failure.afterMs : FAILED_FETCH_BACKOFF_MS,
        ),
      };
      retries.add(retry);
    })
    .finally(() => {
      requests.delete(request);
      for (const id of ids) {
        inflight.delete(id);
      }
      waveformFetchGate.release();
    });
}

/**
 * Bins `[binStart, binStart + count)` of a level as a fresh copy (only
 * copies can be transferred to the raster worker). Bins whose tile is not
 * loaded have `rms = -1`.
 */
export function getBins(
  meta: Pick<PyramidMeta, "key" | "bins_per_tile">,
  level: number,
  binStart: number,
  count: number,
): Int16Array {
  const out = new Int16Array(Math.max(0, count) * BIN_VALUES);
  for (let i = 0; i < count; i++) {
    out[i * BIN_VALUES + 2] = -1;
  }
  const bpt = meta.bins_per_tile;
  const end = binStart + count;
  for (
    let tile = Math.floor(Math.max(0, binStart) / bpt);
    tile * bpt < end;
    tile++
  ) {
    const bins = data.get(tileId(meta.key, level, tile));
    if (!bins) {
      continue;
    }
    const tileStart = tile * bpt;
    const from = Math.max(binStart, tileStart);
    const to = Math.min(end, tileStart + bins.length / BIN_VALUES);
    if (to > from) {
      out.set(
        bins.subarray(
          (from - tileStart) * BIN_VALUES,
          (to - tileStart) * BIN_VALUES,
        ),
        (from - binStart) * BIN_VALUES,
      );
    }
  }
  return out;
}

/** True when every bin in the range is loaded. */
export function hasBins(
  meta: Pick<PyramidMeta, "key" | "bins_per_tile">,
  level: number,
  binStart: number,
  count: number,
): boolean {
  const bpt = meta.bins_per_tile;
  for (
    let tile = Math.floor(Math.max(0, binStart) / bpt);
    tile * bpt < binStart + count;
    tile++
  ) {
    if (!data.has(tileId(meta.key, level, tile))) {
      return false;
    }
  }
  return true;
}

/**
 * On a ready status: the coarsest level, plus the next two finer levels when
 * each is at most 8 tiles, so a zoom-out or a first paint has data at once.
 */
export function prefetchPyramid(source: Source): void {
  const last = source.meta.levels.length - 1;
  for (let level = last; level >= Math.max(0, last - 2); level--) {
    const tiles = levelTileCount(source.meta, level);
    if (level !== last && tiles > PREFETCH_MAX_TILES) {
      continue;
    }
    requestTiles(
      source,
      level,
      Array.from({ length: tiles }, (_, i) => i),
      PRIORITY_PREFETCH,
    );
  }
}

/** A key that is ready again may have the tiles that 404'd. */
function forgetMissing(key: string): void {
  const prefix = `${key}|`;
  for (const id of [...missing]) {
    if (id.startsWith(prefix)) {
      missing.delete(id);
    }
  }
}

onWaveformReady((projectPath, ref, meta) => {
  forgetMissing(meta.key);
  prefetchPyramid({ projectPath, ref, meta });
});

/** Leaving a project: abort its fetches and drop its queue. */
export function retainPyramids(projectPath: string): void {
  for (const request of [...requests]) {
    if (request.projectPath !== projectPath) {
      request.controller.abort();
    }
  }
  for (const [id, p] of pending) {
    if (p.projectPath !== projectPath) {
      pending.delete(id);
    }
  }
  for (const retry of [...retries]) {
    if (retry.projectPath !== projectPath) {
      clearTimeout(retry.timer);
      for (const id of retry.ids) {
        cooling.delete(id);
      }
      retries.delete(retry);
    }
  }
}

/** Drop everything (tests). */
export function resetPyramidStore(): void {
  retainPyramids("\u0000none");
  data.clear();
  missing.clear();
  listeners.clear();
}

/** Loaded data bytes (tests, budgets). */
export function pyramidBytes(): number {
  return data.bytes;
}
