import { type BitmapEntry, bitmapCache } from "./bitmapCache";
import { RASTER_JOBS_OUTSTANDING, RASTER_WORKER_RESTARTS } from "./budgets";
import { listenerSet } from "./listenerSet";
import type {
  RasterInMsg,
  RasterOutMsg,
  WorkerBackend,
} from "./rasterProtocol";
import type { RasterBackend, RasterJob, RasterMode } from "./types";

/**
 * Main-thread side of the raster worker. The worker starts lazily; at most
 * 4 jobs are outstanding. A queued job that is no longer wanted is dropped
 * before sending (never render stale work), but a result that arrives after
 * it stopped being wanted is still cached. A crashed worker (`onerror`, e.g.
 * out of memory, or `onmessageerror`) is restarted up to
 * `RASTER_WORKER_RESTARTS` times per load, and then the backend is `none`.
 * `subscribeRasterFailed` reports the keys of jobs that died with it. No `Worker` or
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
let restarts = 0;
const tilesByMode: Record<RasterMode, number> = { pyramid: 0, pcm: 0, line: 0 };
const queue = new Map<string, RasterRequest>();
const sent = new Map<number, Sent>();
const parityWaiters = new Map<number, (value: number | null) => void>();
const backendListeners = listenerSet();
const doneListeners = listenerSet<[key: string, entry: BitmapEntry]>();
const droppedListeners = listenerSet<[key: string]>();
const failedListeners = listenerSet<[key: string]>();

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
  backendListeners.emit();
}

/** Settle every pending `rasterParity()` with null. */
function settleParity(): void {
  for (const resolve of parityWaiters.values()) {
    resolve(null);
  }
  parityWaiters.clear();
}

/** Stop the worker and forget its jobs; returns their keys (their buffers went with it). */
function stopWorker(): string[] {
  worker?.terminate();
  worker = null;
  const lost = [...sent.values()].map((job) => job.key);
  sent.clear();
  settleParity();
  return lost;
}

/** Settle on backend `none` for good; queued jobs die too. Returns every lost key. */
function giveUp(): string[] {
  const lost = [...stopWorker(), ...queue.keys()];
  queue.clear();
  setBackend("none");
  return lost;
}

function emitFailed(keys: readonly string[]): void {
  for (const key of keys) {
    failedListeners.emit(key);
  }
}

/** `w` crashed: restart it (queued jobs keep their buffers) or give up. */
function onCrash(w: Worker): void {
  if (worker !== w) {
    return; // a replaced worker's late event
  }
  let lost: string[];
  if (restarts < RASTER_WORKER_RESTARTS) {
    restarts += 1;
    lost = stopWorker();
    if (ensureWorker()) {
      pump();
    }
  } else {
    lost = giveUp();
  }
  // After the restart, so a listener's re-request reaches the new worker.
  emitFailed(lost);
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
    tilesByMode[job.job.mode] += 1;
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
      doneListeners.emit(job.key, entry);
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
  let w: Worker;
  try {
    w = new Worker(new URL("./raster.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    emitFailed(giveUp());
    return null;
  }
  worker = w;
  w.onmessage = (ev: MessageEvent<RasterOutMsg>) => {
    if (worker === w) {
      onMessage(ev.data);
    } else if (ev.data.type === "done") {
      ev.data.bitmap.close(); // a replaced worker's late result
    }
  };
  w.onerror = () => onCrash(w);
  w.onmessageerror = () => onCrash(w);
  return w;
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
  const dropped: string[] = [];
  while (sent.size < RASTER_JOBS_OUTSTANDING && queue.size > 0) {
    let best: RasterRequest | null = null;
    for (const [key, req] of queue) {
      if (!req.wanted()) {
        queue.delete(key);
        dropped.push(key);
        continue;
      }
      if (!best || req.priority < best.priority) {
        best = req;
      }
    }
    if (!best) {
      break;
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
  // Another layer may have skipped these keys (`hasRaster`) while they were
  // queued: tell it, so it asks again under its own `wanted`.
  for (const key of dropped) {
    droppedListeners.emit(key);
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

/**
 * True when `requestRaster` would drop a request for `key`: a job with the
 * same `provisional` flag is outstanding, or one is queued, still wanted and
 * at least as urgent as `priority`. Lets callers skip building the job.
 * If that queued job is later dropped as unwanted, `subscribeRasterDropped`
 * reports its key, so a caller that skipped can ask again.
 */
export function hasRaster(
  key: string,
  provisional: boolean,
  priority: number,
): boolean {
  for (const job of sent.values()) {
    if (job.key === key && job.provisional === provisional) {
      return true;
    }
  }
  const queued = queue.get(key);
  return (
    queued != null &&
    queued.provisional === provisional &&
    queued.priority <= priority &&
    queued.wanted()
  );
}

/** Called for every finished render, wanted or not. */
export function subscribeRasterDone(
  listener: (key: string, entry: BitmapEntry) => void,
): () => void {
  return doneListeners.subscribe(listener);
}

/** Called with the key of each queued job dropped because nobody wanted it. */
export function subscribeRasterDropped(
  listener: (key: string) => void,
): () => void {
  return droppedListeners.subscribe(listener);
}

/**
 * Called with the key of each job that died with a crashed worker: those in
 * flight, and on the last crash the queued ones too. A caller that still
 * wants the key asks again (a restarted worker takes it; `none` ignores it).
 */
export function subscribeRasterFailed(
  listener: (key: string) => void,
): () => void {
  return failedListeners.subscribe(listener);
}

/** `none` without Worker / createImageBitmap; `starting` until the worker reports. */
export function getRasterBackend(): RasterBackendState {
  if (backend === "starting" && !supported()) {
    backend = "none";
  }
  return backend;
}

export function subscribeRasterBackend(listener: () => void): () => void {
  return backendListeners.subscribe(listener);
}

/** Start the worker now (it otherwise starts with the first render). */
export function startRasterWorker(): void {
  ensureWorker();
}

/** Raster jobs finished since load (E2E: move/trim must not add any). */
export function rasterTilesRendered(): number {
  return tilesRendered;
}

/** Raster jobs finished since load, by mode (E2E: deep zoom reaches line). */
export function rasterTilesByMode(): Readonly<Record<RasterMode, number>> {
  return { ...tilesByMode };
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
      // The worker could not take the message: settle now, not on the next reset or crash.
      parityWaiters.delete(id);
      resolve(null);
    }
  });
}

/** Stop the worker and forget all state (tests). */
export function resetRasterClient(): void {
  stopWorker();
  backend = "starting";
  queue.clear();
  restarts = 0;
  tilesRendered = 0;
  tilesByMode.pyramid = 0;
  tilesByMode.pcm = 0;
  tilesByMode.line = 0;
  nextId = 1;
}
