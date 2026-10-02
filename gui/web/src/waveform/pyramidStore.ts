import { loadWaveformTiles } from "../api";
import { MAX_TILES_PER_REQUEST } from "../utils/timelineZoom.generated";
import {
  ByteLru,
  classifyFetchFailure,
  fetchLimit,
  holdBackMs,
  MISSING_TILE_RETRY_MS,
  trimOnShellChange,
  waveformBudget,
  waveformFetchGate,
} from "./budgets";
import { keyedListeners } from "./keyedListeners";
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

export type Source = { projectPath: string; ref: string; meta: PyramidMeta };

type Pending = Source & {
  level: number;
  tile: number;
  priority: TilePriority;
  basePriority: TilePriority | null;
  baseSource: Pick<Source, "projectPath" | "ref"> | null;
  owners: Map<
    string,
    { priority: TilePriority; source: Pick<Source, "projectPath" | "ref"> }
  >;
};

export type TileQueueRequest = {
  source: Source;
  level: number;
  tiles: Iterable<number>;
  priority: TilePriority;
};

const data = new ByteLru<Int16Array>(() => waveformBudget().tileBytes);
trimOnShellChange(data);
const pending = new Map<string, Pending>();
const priorityBuckets = new Map<TilePriority, Set<string>>([
  [PRIORITY_VISIBLE, new Set()],
  [PRIORITY_OVERSCAN, new Set()],
  [PRIORITY_PREFETCH, new Set()],
]);
const ownerTiles = new Map<
  string,
  Map<
    string,
    { priority: TilePriority; source: Pick<Source, "projectPath" | "ref"> }
  >
>();
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
/** Tile ids held back after a failed fetch (a 429 or a 503 with Retry-After until Retry-After, otherwise FAILED_FETCH_BACKOFF_MS). */
const cooling = new Set<string>();
/**
 * Tile ids that 404'd or came back short under their key, with the time they
 * may be asked again: skipped until the key is ready again or
 * MISSING_TILE_RETRY_MS passes (a truncated response can recover under the same key).
 */
const missing = new Map<string, number>();

function markMissing(id: string): void {
  missing.set(id, Date.now() + MISSING_TILE_RETRY_MS);
}

/** Whether `id` is still skipped as missing; an expired entry is dropped. */
function stillMissing(id: string): boolean {
  const until = missing.get(id);
  if (until === undefined) {
    return false;
  }
  if (Date.now() < until) {
    return true;
  }
  missing.delete(id);
  return false;
}
const listeners = keyedListeners();

function tileId(key: string, level: number, tile: number): string {
  return `${key}|${level}|${tile}`;
}

/** Called when tiles of pyramid `key` arrive. */
export function subscribePyramid(
  key: string,
  listener: () => void,
): () => void {
  return listeners.subscribe(key, listener);
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
      stillMissing(id)
    ) {
      continue;
    }
    enqueueTile(source, level, tile, priority, null);
  }
  pump();
}

function effectivePriority(p: Pending): TilePriority {
  let priority = p.basePriority ?? PRIORITY_PREFETCH;
  for (const owner of p.owners.values()) {
    priority = Math.min(priority, owner.priority) as TilePriority;
  }
  return priority;
}

function moveTilePriority(p: Pending, priority: TilePriority): void {
  if (p.priority === priority) {
    return;
  }
  priorityBuckets.get(p.priority)!.delete(tileId(p.meta.key, p.level, p.tile));
  p.priority = priority;
  priorityBuckets.get(priority)!.add(tileId(p.meta.key, p.level, p.tile));
}

function enqueueTile(
  source: Source,
  level: number,
  tile: number,
  priority: TilePriority,
  owner: string | null,
): void {
  const id = tileId(source.meta.key, level, tile);
  let queued = pending.get(id);
  if (!queued) {
    queued = {
      ...source,
      level,
      tile,
      priority,
      basePriority: owner === null ? priority : null,
      baseSource: owner === null ? source : null,
      owners: new Map(),
    };
    pending.set(id, queued);
    priorityBuckets.get(priority)!.add(id);
  } else {
    // The latest requester owns the tile, so leaving the other project keeps it.
    queued.projectPath = source.projectPath;
    queued.ref = source.ref;
    if (owner === null) {
      queued.baseSource = source;
      queued.basePriority = Math.min(
        queued.basePriority ?? PRIORITY_PREFETCH,
        priority,
      ) as TilePriority;
    }
    moveTilePriority(queued, effectivePriority(queued));
  }
  if (owner !== null) {
    queued.owners.set(owner, { priority, source });
    moveTilePriority(queued, effectivePriority(queued));
    let owned = ownerTiles.get(owner);
    if (!owned) {
      owned = new Map();
      ownerTiles.set(owner, owned);
    }
    owned.set(id, { priority, source });
  }
}

function refreshTileOwners(p: Pending, id: string): void {
  p.owners = new Map(
    [...ownerTiles]
      .map(([owner, owned]) => [owner, owned.get(id)] as const)
      .filter(
        (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== undefined,
      ),
  );
  const ownerSource = [...p.owners.keys()]
    .reverse()
    .map((owner) => ownerTiles.get(owner)?.get(id)?.source)
    .find((source) => source !== undefined);
  const source = ownerSource ?? p.baseSource;
  if (source) {
    p.projectPath = source.projectPath;
    p.ref = source.ref;
  }
}

function requeueTile(p: Pending, id: string, includeBasePriority = true): void {
  refreshTileOwners(p, id);
  if (
    p.owners.size === 0 &&
    (!includeBasePriority || p.basePriority === null)
  ) {
    return;
  }
  p.priority = effectivePriority(p);
  pending.set(id, p);
  priorityBuckets.get(p.priority)!.add(id);
}

/** Replace one mounted layer's queued tile interest with its current view. */
export function replaceTileRequests(
  owner: string,
  requests: readonly TileQueueRequest[],
): void {
  const next = new Map<
    string,
    { source: Source; level: number; tile: number; priority: TilePriority }
  >();
  for (const request of requests) {
    const count = levelTileCount(request.source.meta, request.level);
    for (const tile of request.tiles) {
      if (tile < 0 || tile >= count) {
        continue;
      }
      const id = tileId(request.source.meta.key, request.level, tile);
      const current = next.get(id);
      if (!current || request.priority < current.priority) {
        next.set(id, {
          source: request.source,
          level: request.level,
          tile,
          priority: request.priority,
        });
      }
    }
  }

  const previous = ownerTiles.get(owner);
  if (previous) {
    for (const [id] of previous) {
      if (next.has(id)) {
        continue;
      }
      const queued = pending.get(id);
      if (!queued) {
        continue;
      }
      queued.owners.delete(owner);
      const ownerSource = [...queued.owners.keys()]
        .reverse()
        .map((remaining) => ownerTiles.get(remaining)?.get(id)?.source)
        .find((source) => source !== undefined);
      const source = ownerSource ?? queued.baseSource;
      if (source) {
        queued.projectPath = source.projectPath;
        queued.ref = source.ref;
      }
      if (queued.basePriority === null && queued.owners.size === 0) {
        pending.delete(id);
        priorityBuckets.get(queued.priority)!.delete(id);
      } else {
        moveTilePriority(queued, effectivePriority(queued));
      }
    }
  }

  ownerTiles.delete(owner);
  for (const [id, request] of next) {
    if (
      data.has(id) ||
      inflight.has(id) ||
      cooling.has(id) ||
      stillMissing(id)
    ) {
      continue;
    }
    enqueueTile(
      request.source,
      request.level,
      request.tile,
      request.priority,
      owner,
    );
  }
  if (next.size > 0) {
    ownerTiles.set(
      owner,
      new Map(
        [...next].map(([id, request]) => [
          id,
          { priority: request.priority, source: request.source },
        ]),
      ),
    );
  }
  pump();
}

/** The most urgent queued tile (lowest priority value, then oldest). */
function nextPending(): Pending | null {
  for (const priority of [
    PRIORITY_VISIBLE,
    PRIORITY_OVERSCAN,
    PRIORITY_PREFETCH,
  ] as const) {
    const id = priorityBuckets.get(priority)!.values().next().value;
    if (id !== undefined) {
      const item = pending.get(id);
      if (item) {
        return item;
      }
    }
  }
  return null;
}

/** A run of queued, consecutive tiles of `head`'s level around it. */
function runAround(head: Pending): Pending[] {
  const { key } = head.meta;
  let start = head.tile;
  while (
    head.tile - start + 1 < MAX_TILES_PER_REQUEST &&
    pending.get(tileId(key, head.level, start - 1))?.priority === head.priority
  ) {
    start -= 1;
  }
  const run: Pending[] = [];
  for (
    let t = start;
    run.length < MAX_TILES_PER_REQUEST &&
    pending.get(tileId(key, head.level, t))?.priority === head.priority;
    t++
  ) {
    run.push(pending.get(tileId(key, head.level, t))!);
  }
  return run;
}

function pump(): void {
  waveformFetchGate.setQueued("tiles", pending.size);
  for (;;) {
    const head = nextPending();
    if (
      !head ||
      !waveformFetchGate.tryAcquire(fetchLimit(head.projectPath), "tiles")
    ) {
      return;
    }
    const run = runAround(head);
    dispatch(run);
    waveformFetchGate.setQueued("tiles", pending.size);
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
      markMissing(id);
      continue;
    }
    const bins = all.slice(offset, offset + n);
    offset += n;
    data.set(id, bins, bins.byteLength);
  }
  listeners.notify(head.meta.key);
  if (short) {
    noteWaveformTileMissing(head.projectPath, head.ref, head.meta.key);
  }
}

function dispatch(run: Pending[]): void {
  const head = run[0]!;
  const ids = run.map((p) => tileId(p.meta.key, p.level, p.tile));
  for (const id of ids) {
    pending.delete(id);
    priorityBuckets.get(run[0]!.priority)!.delete(id);
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
          markMissing(id);
        }
        noteWaveformTileMissing(head.projectPath, head.ref, head.meta.key);
        return;
      }
      // Hold the run back: a 429 or a 503 with Retry-After until Retry-After (then re-queue it), anything else briefly.
      for (const id of ids) {
        cooling.add(id);
      }
      const retry = {
        projectPath: head.projectPath,
        ids,
        timer: setTimeout(() => {
          retries.delete(retry);
          for (const id of ids) {
            cooling.delete(id);
          }
          if (failure.kind === "retry") {
            for (const p of run) {
              const id = tileId(p.meta.key, p.level, p.tile);
              refreshTileOwners(p, id);
              if (
                !data.has(id) &&
                !inflight.has(id) &&
                !pending.has(id) &&
                (p.owners.size > 0 ||
                  (p.basePriority !== null &&
                    p.baseSource?.projectPath === retry.projectPath))
              ) {
                requeueTile(p, id);
              }
            }
          }
          pump();
        }, holdBackMs(failure)),
      };
      retries.add(retry);
    })
    .finally(() => {
      requests.delete(request);
      for (const id of ids) {
        inflight.delete(id);
      }
      if (request.controller.signal.aborted) {
        for (const p of run) {
          const id = tileId(p.meta.key, p.level, p.tile);
          if (!data.has(id) && !pending.has(id)) {
            requeueTile(p, id, false);
          }
        }
        waveformFetchGate.setQueued("tiles", pending.size);
      }
      waveformFetchGate.release("tiles");
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
  for (const id of [...missing.keys()]) {
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
      priorityBuckets.get(p.priority)!.delete(id);
    }
  }
  for (const retry of [...retries]) {
    if (retry.projectPath !== projectPath) {
      const kept = retry.ids.some((id) =>
        [...ownerTiles.values()].some(
          (owned) => owned.get(id)?.source.projectPath === projectPath,
        ),
      );
      if (kept) {
        retry.projectPath = projectPath;
        continue;
      }
      clearTimeout(retry.timer);
      for (const id of retry.ids) {
        cooling.delete(id);
      }
      retries.delete(retry);
    }
  }
  for (const [owner, owned] of ownerTiles) {
    for (const [id, interest] of owned) {
      if (interest.source.projectPath !== projectPath) {
        owned.delete(id);
        const queued = pending.get(id);
        if (queued) {
          refreshTileOwners(queued, id);
          if (queued.basePriority === null && queued.owners.size === 0) {
            pending.delete(id);
            priorityBuckets.get(queued.priority)!.delete(id);
          } else {
            moveTilePriority(queued, effectivePriority(queued));
          }
        }
      }
    }
    if (owned.size === 0) {
      ownerTiles.delete(owner);
    }
  }
  pump();
}

/** Drop everything (tests). */
export function resetPyramidStore(): void {
  retainPyramids("\u0000none");
  data.clear();
  missing.clear();
  ownerTiles.clear();
  listeners.clear();
}

/** Loaded data bytes (tests, budgets). */
export function pyramidBytes(): number {
  return data.bytes;
}
