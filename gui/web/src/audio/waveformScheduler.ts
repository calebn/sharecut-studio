import { isShareProjectKey } from "../shareMode";
import { TILE_SEC } from "../utils/timelineZoom.generated";
import { getActiveProxyEngine } from "./proxyPeek";
import {
  clearWavHeaderCache,
  DETAIL_FETCH_MAX_SEC,
  fetchDetailPeaks,
  type WaveformKind,
} from "./waveformSource";
import {
  coalesceIndices,
  PeakTileLru,
  tileKey,
  type WaveformTile,
} from "./waveformTiles";

export type TilePriority = 0 | 1 | 2 | 3;

export const PRIORITY_LOUPE = 0 as const;
export const PRIORITY_POINTER = 1 as const;
export const PRIORITY_VISIBLE = 2 as const;
export const PRIORITY_PREFETCH = 3 as const;

export type SchedulerRequest = {
  projectPath: string;
  trackId: string;
  kind: WaveformKind;
  mediaPath: string | null;
  mediaVersion: string;
  startSec: number;
  endSec: number;
  binsPerSec: number;
  priority: TilePriority;
};

type Job = SchedulerRequest & {
  indices: number[];
  controller: AbortController;
  generation: number;
};

const IN_FLIGHT_CAP = 2;
const FETCH_TILES = Math.max(1, Math.round(DETAIL_FETCH_MAX_SEC / TILE_SEC));
const lru = new PeakTileLru(512);
const queue: Job[] = [];
const inflight = new Set<Job>();
const listeners = new Map<string, Set<() => void>>();
let generation = 0;
let lastScrollDir: -1 | 1 = 1;

export function getWaveformTileLru(): PeakTileLru {
  return lru;
}

export function subscribeWaveformTiles(
  trackId: string,
  fn: () => void,
): () => void {
  let set = listeners.get(trackId);
  if (!set) {
    set = new Set();
    listeners.set(trackId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) {
      listeners.delete(trackId);
    }
  };
}

function notify(trackId: string): void {
  for (const fn of listeners.get(trackId) ?? []) {
    fn();
  }
}

export function noteWaveformScrollDir(dir: -1 | 1): void {
  lastScrollDir = dir;
}

export function abortStaleWaveformWork(): void {
  generation += 1;
  for (const job of [...queue, ...inflight]) {
    job.controller.abort();
  }
  queue.length = 0;
  inflight.clear();
}

function jobTileKey(job: Job, index: number): string {
  return tileKey(
    job.projectPath,
    job.trackId,
    job.kind,
    job.mediaVersion,
    index,
    job.binsPerSec,
  );
}

function occupiedTileKeys(): Set<string> {
  const keys = new Set<string>();
  for (const job of [...queue, ...inflight]) {
    for (const i of job.indices) {
      keys.add(jobTileKey(job, i));
    }
  }
  return keys;
}

function pruneQueue(req: SchedulerRequest): void {
  const reqI0 = Math.floor(req.startSec / TILE_SEC);
  const reqI1 = Math.floor(
    Math.max(req.startSec, req.endSec - 1e-9) / TILE_SEC,
  );
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (
      job.projectPath !== req.projectPath ||
      job.trackId !== req.trackId ||
      job.kind !== req.kind
    ) {
      continue;
    }
    const staleRate = job.binsPerSec !== req.binsPerSec;
    const stalePrefetch = job.priority === PRIORITY_PREFETCH;
    const staleWindow =
      job.priority <= PRIORITY_VISIBLE &&
      !job.indices.some((idx) => idx >= reqI0 && idx <= reqI1);
    if (staleRate || stalePrefetch || staleWindow) {
      job.controller.abort();
      queue.splice(i, 1);
    }
  }
  for (const job of inflight) {
    if (
      job.projectPath === req.projectPath &&
      job.trackId === req.trackId &&
      job.kind === req.kind &&
      job.binsPerSec !== req.binsPerSec
    ) {
      job.controller.abort();
    }
  }
}

function jobSort(a: Job, b: Job): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return a.trackId.localeCompare(b.trackId);
}

function pump(): void {
  while (inflight.size < IN_FLIGHT_CAP && queue.length > 0) {
    queue.sort(jobSort);
    const job = queue.shift();
    if (!job || job.generation !== generation) {
      continue;
    }
    inflight.add(job);
    void runJob(job).finally(() => {
      inflight.delete(job);
      pump();
    });
  }
}

function chunkRange(lo: number, hi: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let chunkLo = lo; chunkLo <= hi; chunkLo += FETCH_TILES) {
    out.push([chunkLo, Math.min(hi, chunkLo + FETCH_TILES - 1)]);
  }
  return out;
}

async function runJob(job: Job): Promise<void> {
  const missing = job.indices.filter((i) => !lru.has(jobTileKey(job, i)));
  if (missing.length === 0) {
    return;
  }
  const ranges = coalesceIndices(missing).flatMap(([lo, hi]) =>
    chunkRange(lo, hi),
  );
  for (const [lo, hi] of ranges) {
    if (job.controller.signal.aborted || job.generation !== generation) {
      return;
    }
    const startSec = lo * TILE_SEC;
    const endSec = (hi + 1) * TILE_SEC;
    try {
      const peaks = await fetchDetailPeaks({
        projectPath: job.projectPath,
        trackId: job.trackId,
        kind: job.kind,
        mediaPath: job.mediaPath,
        mediaVersion: job.mediaVersion,
        startSec,
        endSec,
        binsPerSec: job.binsPerSec,
        signal: job.controller.signal,
      });
      if (
        !peaks ||
        job.generation !== generation ||
        job.controller.signal.aborted
      ) {
        continue;
      }
      const span = hi - lo + 1;
      const binsPerTile = Math.max(1, Math.round(job.binsPerSec * TILE_SEC));
      let wrote = false;
      for (let i = 0; i < span; i++) {
        const idx = lo + i;
        const sliceStart = i * binsPerTile;
        const slice = peaks.slice(sliceStart, sliceStart + binsPerTile);
        if (slice.length === 0) {
          continue;
        }
        lru.set({
          key: jobTileKey(job, idx),
          projectPath: job.projectPath,
          trackId: job.trackId,
          kind: job.kind,
          mediaVersion: job.mediaVersion,
          tileIndex: idx,
          binsPerSec: job.binsPerSec,
          startSec: idx * TILE_SEC,
          endSec: (idx + 1) * TILE_SEC,
          peaks: slice,
        });
        wrote = true;
      }
      if (wrote) {
        notify(job.trackId);
      }
    } catch (err) {
      if (job.controller.signal.aborted) {
        return;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      notify(job.trackId);
    }
  }
}

export function requestWaveformTiles(req: SchedulerRequest): WaveformTile[] {
  pruneQueue(req);
  const i0 = Math.floor(req.startSec / TILE_SEC);
  const i1 = Math.floor(Math.max(req.startSec, req.endSec - 1e-9) / TILE_SEC);
  const indices: number[] = [];
  const found: WaveformTile[] = [];
  for (let i = i0; i <= i1; i++) {
    indices.push(i);
    const hit = lru.get(
      tileKey(
        req.projectPath,
        req.trackId,
        req.kind,
        req.mediaVersion,
        i,
        req.binsPerSec,
      ),
    );
    if (hit) {
      found.push(hit);
    }
  }
  if (isShareProjectKey(req.projectPath) && !getActiveProxyEngine()) {
    return found;
  }
  const occupied = occupiedTileKeys();
  const missing = indices.filter((i) => {
    const key = tileKey(
      req.projectPath,
      req.trackId,
      req.kind,
      req.mediaVersion,
      i,
      req.binsPerSec,
    );
    return !lru.has(key) && !occupied.has(key);
  });
  if (missing.length > 0) {
    const controller = new AbortController();
    queue.push({
      ...req,
      indices: missing,
      controller,
      generation,
    });
    if (req.priority <= PRIORITY_VISIBLE) {
      const prefetch = lastScrollDir > 0 ? i1 + 1 : i0 - 1;
      if (prefetch >= 0) {
        const prefetchKey = tileKey(
          req.projectPath,
          req.trackId,
          req.kind,
          req.mediaVersion,
          prefetch,
          req.binsPerSec,
        );
        if (!lru.has(prefetchKey) && !occupied.has(prefetchKey)) {
          queue.push({
            ...req,
            priority: PRIORITY_PREFETCH,
            startSec: prefetch * TILE_SEC,
            endSec: (prefetch + 1) * TILE_SEC,
            indices: [prefetch],
            controller: new AbortController(),
            generation,
          });
        }
      }
    }
    pump();
  }
  return found;
}

export function inflightWaveformCount(): number {
  return inflight.size;
}

export function queuedWaveformCount(): number {
  return queue.length;
}

export function resetWaveformSchedulerForTests(): void {
  abortStaleWaveformWork();
  generation = 0;
  lru.clear();
  listeners.clear();
  clearWavHeaderCache();
}
