import { loadWaveformPcm } from "../api";
import { isShareProjectKey } from "../shareMode";
import { PCM_BLOCK_FRAMES } from "../utils/timelineZoom.generated";
import {
  ByteLru,
  classifyFetchFailure,
  FAILED_FETCH_BACKOFF_MS,
  fetchLimit,
  trimOnShellChange,
  waveformBudget,
  waveformFetchGate,
} from "./budgets";
import { refreshWaveformStatus } from "./statusStore";
import { refKind } from "./types";

/**
 * Host deep-zoom PCM: per-frame `(min, max)` pairs in blocks of
 * `pcm_block_frames` frames (S8 budget, the shared fetch gate). Guests never
 * reach this store. A 409 means the key is stale, so the status is polled
 * again; a 429 re-queues after `Retry-After`.
 */

type Block = { projectPath: string; ref: string; key: string; block: number };

const data = new ByteLru<Int16Array>(() => waveformBudget().pcmBytes);
trimOnShellChange(data);
const queue = new Map<string, Block>();
const inflight = new Set<string>();
const requests = new Set<{
  projectPath: string;
  controller: AbortController;
}>();
const retries = new Set<{
  projectPath: string;
  id: string;
  timer: ReturnType<typeof setTimeout>;
}>();
/** Block ids held back after a failed fetch (a 429 until Retry-After, otherwise FAILED_FETCH_BACKOFF_MS). */
const cooling = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function blockId(key: string, block: number): string {
  return `${key}|${block}`;
}

export function subscribePcm(key: string, listener: () => void): () => void {
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

/** Queue PCM blocks `[b0, b1]` of a ref (host projects only). */
export function requestPcm(
  source: { projectPath: string; ref: string; key: string },
  b0: number,
  b1: number,
): void {
  if (isShareProjectKey(source.projectPath)) {
    return;
  }
  for (let block = Math.max(0, b0); block <= b1; block++) {
    const id = blockId(source.key, block);
    if (data.has(id) || inflight.has(id) || cooling.has(id)) {
      continue;
    }
    const queued = queue.get(id);
    if (queued) {
      // The latest requester owns the block, so leaving the other project keeps it.
      queued.projectPath = source.projectPath;
      queued.ref = source.ref;
      continue;
    }
    queue.set(id, { ...source, block });
  }
  pump();
}

function pump(): void {
  for (const [id, block] of queue) {
    if (!waveformFetchGate.tryAcquire(fetchLimit(block.projectPath))) {
      return;
    }
    queue.delete(id);
    dispatch(id, block);
  }
}

// Tiles and PCM share the gate: a slot either store frees wakes both.
waveformFetchGate.onRelease(pump);

function dispatch(id: string, block: Block): void {
  inflight.add(id);
  const request = {
    projectPath: block.projectPath,
    controller: new AbortController(),
  };
  requests.add(request);
  loadWaveformPcm(
    block.projectPath,
    { key: block.key, ref: block.ref, block: block.block },
    request.controller.signal,
  )
    .then((buf) => {
      if (request.controller.signal.aborted) {
        return;
      }
      const pcm = new Int16Array(
        buf.slice(0, buf.byteLength - (buf.byteLength % 4)),
      );
      data.set(id, pcm, pcm.byteLength);
      for (const fn of [...(listeners.get(block.key) ?? [])]) {
        fn();
      }
    })
    .catch((err: unknown) => {
      if (request.controller.signal.aborted) {
        return;
      }
      const failure = classifyFetchFailure(err);
      if (failure.kind === "stale" || failure.kind === "missing") {
        refreshWaveformStatus(block.projectPath, refKind(block.ref));
      }
      // Hold the block back: a 429 until Retry-After (then re-queue it), anything else briefly.
      cooling.add(id);
      const retry = {
        projectPath: block.projectPath,
        id,
        timer: setTimeout(
          () => {
            retries.delete(retry);
            cooling.delete(id);
            if (
              failure.kind === "retry" &&
              !data.has(id) &&
              !inflight.has(id) &&
              !queue.has(id)
            ) {
              queue.set(id, block);
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
      inflight.delete(id);
      waveformFetchGate.release();
    });
}

/**
 * Frames `[frameStart, frameStart + frames]` (one past the right edge, for
 * the interpolant), clipped to the media, as a fresh copy of `(min, max)`
 * pairs from `pcmStart`; null until every block needed is loaded.
 */
export function getPcm(
  key: string,
  frameStart: number,
  frames: number,
  totalFrames: number,
): { pcm: Int16Array; pcmStart: number } | null {
  const f0 = Math.max(0, Math.floor(frameStart));
  const f1 = Math.min(totalFrames - 1, Math.ceil(frameStart + frames));
  if (f1 < f0) {
    return null;
  }
  const out = new Int16Array((f1 - f0 + 1) * 2);
  for (
    let block = Math.floor(f0 / PCM_BLOCK_FRAMES);
    block <= Math.floor(f1 / PCM_BLOCK_FRAMES);
    block++
  ) {
    const pcm = data.get(blockId(key, block));
    if (!pcm) {
      return null;
    }
    const start = block * PCM_BLOCK_FRAMES;
    const from = Math.max(f0, start);
    const to = Math.min(f1 + 1, start + pcm.length / 2);
    if (to < Math.min(f1 + 1, start + PCM_BLOCK_FRAMES)) {
      return null;
    }
    out.set(
      pcm.subarray((from - start) * 2, (to - start) * 2),
      (from - f0) * 2,
    );
  }
  return { pcm: out, pcmStart: f0 };
}

/** Leaving a project: abort its fetches and drop its queue. */
export function retainPcm(projectPath: string): void {
  for (const request of [...requests]) {
    if (request.projectPath !== projectPath) {
      request.controller.abort();
    }
  }
  for (const [id, block] of queue) {
    if (block.projectPath !== projectPath) {
      queue.delete(id);
    }
  }
  for (const retry of [...retries]) {
    if (retry.projectPath !== projectPath) {
      clearTimeout(retry.timer);
      cooling.delete(retry.id);
      retries.delete(retry);
    }
  }
}

/** Drop everything (tests). */
export function resetPcmStore(): void {
  retainPcm("\u0000none");
  data.clear();
  listeners.clear();
}
