import { type BitmapEntry, bitmapCache } from "./bitmapCache";
import { RASTER_JOBS_OUTSTANDING } from "./budgets";
import type {
  RasterInMsg,
  RasterOutMsg,
  WorkerBackend,
} from "./rasterProtocol";
import type { RasterBackend, RasterJob } from "./types";

/**
 * Main-thread side of the raster worker. The worker starts lazily; at most
 * 4 jobs are outstanding. A queued job that is no longer wanted is dropped
 * before sending (never render stale work), but a result that arrives after
 * it stopped being wanted is still cached. No `Worker` or
 * `createImageBitmap` (jsdom) means backend `none`: nothing renders.
 */

export type RasterBackendState = RasterBackend | "starting";

export type RasterRequest = {
  /** Tile key (`renderTiles.tileKey`). */
  key: string;
  job: RasterJob;
  /** Placeholder group and tile position (`renderTiles.tileGroup`). */
  group: string;
  zoom: number;
  tile: number;
  /** Rendered from a coarser level: cached as a stand-in only. */
  provisional: boolean;
  /** Lower is sooner (visible before overscan). */
  priority: number;
  /** Checked right before sending; false drops the job. */
  wanted: () => boolean;
};

type Sent = RasterRequest & { id: number };

let worker: Worker | null = null;
let backend: RasterBackendState = "starting";
let nextId = 1;
let tilesRendered = 0;
const queue = new Map<string, RasterRequest>();
const sent = new Map<number, Sent>();
const parityWaiters = new Map<number, (value: number | null) => void>();
const backendListeners = new Set<() => void>();
const doneListeners = new Set<(key: string, entry: BitmapEntry) => void>();

function supported(): boolean {
  return (
    typeof Worker !== "undefined" && typeof createImageBitmap !== "undefined"
  );
}

function setBackend(next: RasterBackendState): void {
  if (backend === next) {
    return;
  }
  backend = next;
  for (const fn of [...backendListeners]) {
    fn();
  }
}

/** Settle every pending `rasterParity()` with null. */
function settleParity(): void {
  for (const resolve of parityWaiters.values()) {
    resolve(null);
  }
  parityWaiters.clear();
}

function fail(): void {
  worker?.terminate();
  worker = null;
  queue.clear();
  sent.clear();
  settleParity();
  setBackend("none");
}

function onMessage(msg: RasterOutMsg): void {
  if (msg.type === "ready") {
    setBackend(msg.backend);
    return;
  }
  if (msg.type === "parity") {
    parityWaiters.get(msg.id)?.(msg.value);
    parityWaiters.delete(msg.id);
    return;
  }
  const job = sent.get(msg.id);
  sent.delete(msg.id);
  if (msg.type === "done" && !job) {
    // Its job was forgotten (reset, worker failure, duplicate id): nobody draws it.
    msg.bitmap.close();
  }
  if (msg.type === "done" && job) {
    setBackend(msg.backend satisfies WorkerBackend);
    tilesRendered += 1;
    const entry: BitmapEntry = {
      bitmap: msg.bitmap,
      width: job.job.cols,
      height: job.job.rows,
      group: job.group,
      zoom: job.zoom,
      tile: job.tile,
      provisional: job.provisional,
    };
    bitmapCache.set(job.key, entry);
    // An entry over the whole budget is evicted (and closed) on insert.
    if (bitmapCache.holds(job.key, entry)) {
      for (const fn of [...doneListeners]) {
        fn(job.key, entry);
      }
    }
  }
  pump();
}

function ensureWorker(): Worker | null {
  if (worker) {
    return worker;
  }
  if (backend === "none") {
    return null;
  }
  if (!supported()) {
    setBackend("none");
    return null;
  }
  try {
    worker = new Worker(new URL("./raster.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    fail();
    return null;
  }
  worker.onmessage = (ev: MessageEvent<RasterOutMsg>) => onMessage(ev.data);
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return worker;
}

function post(w: Worker, msg: RasterInMsg): void {
  const transfer: Transferable[] = [];
  if (msg.type === "render") {
    const src = msg.job.source;
    transfer.push(src.kind === "pyramid" ? src.bins.buffer : src.pcm.buffer);
  }
  w.postMessage(msg, transfer);
}

function pump(): void {
  const w = worker;
  if (!w) {
    return;
  }
  while (sent.size < RASTER_JOBS_OUTSTANDING && queue.size > 0) {
    let best: RasterRequest | null = null;
    for (const [key, req] of queue) {
      if (!req.wanted()) {
        queue.delete(key);
        continue;
      }
      if (!best || req.priority < best.priority) {
        best = req;
      }
    }
    if (!best) {
      return;
    }
    queue.delete(best.key);
    const id = nextId++;
    sent.set(id, { ...best, id });
    try {
      post(w, { type: "render", id, job: best.job });
    } catch {
      // e.g. a DataCloneError on a detached buffer: drop the job, free its slot.
      sent.delete(id);
    }
  }
}

/** Queue a tile render; a job already queued or outstanding for `key` is kept. */
export function requestRaster(req: RasterRequest): void {
  if (!ensureWorker()) {
    return;
  }
  for (const job of sent.values()) {
    if (job.key === req.key && job.provisional === req.provisional) {
      return;
    }
  }
  const queued = queue.get(req.key);
  if (queued && !queued.provisional && req.provisional) {
    // Never let a stand-in replace a queued exact render.
    return;
  }
  queue.set(req.key, req);
  pump();
}

/** Called for every finished render, wanted or not. */
export function subscribeRasterDone(
  listener: (key: string, entry: BitmapEntry) => void,
): () => void {
  doneListeners.add(listener);
  return () => doneListeners.delete(listener);
}

/** `none` without Worker / createImageBitmap; `starting` until the worker reports. */
export function getRasterBackend(): RasterBackendState {
  if (backend === "starting" && !supported()) {
    backend = "none";
  }
  return backend;
}

export function subscribeRasterBackend(listener: () => void): () => void {
  backendListeners.add(listener);
  return () => backendListeners.delete(listener);
}

/** Start the worker now (it otherwise starts with the first render). */
export function startRasterWorker(): void {
  ensureWorker();
}

/** Raster jobs finished since load (E2E: move/trim must not add any). */
export function rasterTilesRendered(): number {
  return tilesRendered;
}

/** GL vs CPU difference on a fixed tile, in the worker; null without GL. */
export function rasterParity(): Promise<number | null> {
  const w = ensureWorker();
  if (!w) {
    return Promise.resolve(null);
  }
  const id = nextId++;
  return new Promise((resolve) => {
    parityWaiters.set(id, resolve);
    try {
      post(w, { type: "parity", id });
    } catch {
      // The worker could not take the message: settle now, not on the next reset.
      parityWaiters.delete(id);
      resolve(null);
    }
  });
}

/** Stop the worker and forget all state (tests). */
export function resetRasterClient(): void {
  worker?.terminate();
  worker = null;
  backend = "starting";
  queue.clear();
  sent.clear();
  settleParity();
  tilesRendered = 0;
  nextId = 1;
}
