import { loadWaveformPcm } from "../api";
import { isShareProjectKey } from "../shareMode";
import { PCM_BLOCK_FRAMES } from "../utils/timelineZoom.generated";
import {
  ByteLru,
  classifyFetchFailure,
  fetchLimit,
  holdBackMs,
  trimOnShellChange,
  waveformBudget,
  waveformFetchGate,
} from "./budgets";
import { keyedListeners } from "./keyedListeners";
import type { TilePriority } from "./pyramidStore";
import { refreshWaveformStatus } from "./statusStore";
import { refKind } from "./types";

/**
 * Host deep-zoom PCM: per-frame `(min, max)` pairs in blocks of
 * `pcm_block_frames` frames (S8 budget, the shared fetch gate). Guests never
 * reach this store. A 409 means the key is stale, so the status is polled
 * again; a 429, or a 503 with `Retry-After` (every host decode slot busy),
 * re-queues after `Retry-After`.
 */

type Block = {
  projectPath: string;
  ref: string;
  key: string;
  block: number;
  priority: TilePriority;
  basePriority: TilePriority | null;
  baseSource: Pick<PcmQueueRequest["source"], "projectPath" | "ref"> | null;
  owners: Map<
    string,
    {
      priority: TilePriority;
      source: Pick<PcmQueueRequest["source"], "projectPath" | "ref">;
    }
  >;
};

export type PcmQueueRequest = {
  source: { projectPath: string; ref: string; key: string };
  b0: number;
  b1: number;
  priority: TilePriority;
};

export const MAX_PCM_BLOCKS_PER_REQUEST = 64;
const PRIORITY_VISIBLE: TilePriority = 0;
const PRIORITY_OVERSCAN: TilePriority = 1;
const PRIORITY_PREFETCH: TilePriority = 2;

const data = new ByteLru<Int16Array>(() => waveformBudget().pcmBytes);
trimOnShellChange(data);
const queue = new Map<string, Block>();
const priorityBuckets = new Map<TilePriority, Set<string>>([
  [PRIORITY_VISIBLE, new Set()],
  [PRIORITY_OVERSCAN, new Set()],
  [PRIORITY_PREFETCH, new Set()],
]);
const ownerBlocks = new Map<
  string,
  Map<string, { priority: TilePriority; source: PcmQueueRequest["source"] }>
>();
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
/** Block ids held back after a failed fetch (a 429 or busy 503 until Retry-After, otherwise FAILED_FETCH_BACKOFF_MS). */
const cooling = new Set<string>();
const listeners = keyedListeners();

function blockId(key: string, block: number): string {
  return `${key}|${block}`;
}

export function subscribePcm(key: string, listener: () => void): () => void {
  return listeners.subscribe(key, listener);
}

/** Queue PCM blocks `[b0, b1]` of a ref (host projects only). */
export function requestPcm(
  source: { projectPath: string; ref: string; key: string },
  b0: number,
  b1: number,
  priority: TilePriority = PRIORITY_VISIBLE,
): void {
  if (isShareProjectKey(source.projectPath)) {
    return;
  }
  const first = Math.max(0, Math.floor(b0));
  const last = Math.min(b1, first + MAX_PCM_BLOCKS_PER_REQUEST - 1);
  for (let block = first; block <= last; block++) {
    const id = blockId(source.key, block);
    if (data.has(id) || inflight.has(id) || cooling.has(id)) {
      continue;
    }
    enqueueBlock(source, block, priority, null);
  }
  pump();
}

function effectivePriority(block: Block): TilePriority {
  let priority = block.basePriority ?? PRIORITY_PREFETCH;
  for (const owner of block.owners.values()) {
    priority = Math.min(priority, owner.priority) as TilePriority;
  }
  return priority;
}

function moveBlockPriority(block: Block, priority: TilePriority): void {
  if (block.priority === priority) {
    return;
  }
  const id = blockId(block.key, block.block);
  priorityBuckets.get(block.priority)!.delete(id);
  block.priority = priority;
  priorityBuckets.get(priority)!.add(id);
}

function enqueueBlock(
  source: { projectPath: string; ref: string; key: string },
  blockNumber: number,
  priority: TilePriority,
  owner: string | null,
): void {
  const id = blockId(source.key, blockNumber);
  let queued = queue.get(id);
  if (!queued) {
    queued = {
      ...source,
      block: blockNumber,
      priority,
      basePriority: owner === null ? priority : null,
      baseSource: owner === null ? source : null,
      owners: new Map(),
    };
    queue.set(id, queued);
    priorityBuckets.get(priority)!.add(id);
  } else {
    // The latest requester owns the block, so leaving the other project keeps it.
    queued.projectPath = source.projectPath;
    queued.ref = source.ref;
    if (owner === null) {
      queued.baseSource = source;
      queued.basePriority = Math.min(
        queued.basePriority ?? PRIORITY_PREFETCH,
        priority,
      ) as TilePriority;
    }
  }
  if (owner !== null) {
    queued.owners.set(owner, { priority, source });
    let owned = ownerBlocks.get(owner);
    if (!owned) {
      owned = new Map();
      ownerBlocks.set(owner, owned);
    }
    owned.set(id, { priority, source });
  }
  moveBlockPriority(queued, effectivePriority(queued));
}

function refreshBlockOwners(block: Block, id: string): void {
  block.owners = new Map(
    [...ownerBlocks]
      .map(([owner, owned]) => [owner, owned.get(id)] as const)
      .filter(
        (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== undefined,
      ),
  );
  const ownerSource = [...block.owners.keys()]
    .reverse()
    .map((owner) => ownerBlocks.get(owner)?.get(id)?.source)
    .find((source) => source !== undefined);
  const source = ownerSource ?? block.baseSource;
  if (source) {
    block.projectPath = source.projectPath;
    block.ref = source.ref;
  }
}

function requeueBlock(
  block: Block,
  id: string,
  includeBasePriority = true,
): void {
  refreshBlockOwners(block, id);
  if (
    block.owners.size === 0 &&
    (!includeBasePriority || block.basePriority === null)
  ) {
    return;
  }
  block.priority = effectivePriority(block);
  queue.set(id, block);
  priorityBuckets.get(block.priority)!.add(id);
}

/** Replace one mounted layer's queued PCM interest with its current view. */
export function replacePcmRequests(
  owner: string,
  requests: readonly PcmQueueRequest[],
): void {
  const next = new Map<
    string,
    { source: PcmQueueRequest["source"]; block: number; priority: TilePriority }
  >();
  for (const request of requests) {
    if (isShareProjectKey(request.source.projectPath)) {
      continue;
    }
    const first = Math.max(0, Math.floor(request.b0));
    const last = Math.min(request.b1, first + MAX_PCM_BLOCKS_PER_REQUEST - 1);
    for (let block = first; block <= last; block++) {
      const id = blockId(request.source.key, block);
      const current = next.get(id);
      if (!current || request.priority < current.priority) {
        next.set(id, {
          source: request.source,
          block,
          priority: request.priority,
        });
      }
    }
  }

  const previous = ownerBlocks.get(owner);
  if (previous) {
    for (const [id] of previous) {
      if (next.has(id)) {
        continue;
      }
      const queued = queue.get(id);
      if (!queued) {
        continue;
      }
      queued.owners.delete(owner);
      const ownerSource = [...queued.owners.keys()]
        .reverse()
        .map((remaining) => ownerBlocks.get(remaining)?.get(id)?.source)
        .find((source) => source !== undefined);
      const source = ownerSource ?? queued.baseSource;
      if (source) {
        queued.projectPath = source.projectPath;
        queued.ref = source.ref;
      }
      if (queued.basePriority === null && queued.owners.size === 0) {
        queue.delete(id);
        priorityBuckets.get(queued.priority)!.delete(id);
      } else {
        moveBlockPriority(queued, effectivePriority(queued));
      }
    }
  }

  ownerBlocks.delete(owner);
  for (const [id, request] of next) {
    if (data.has(id) || inflight.has(id) || cooling.has(id)) {
      continue;
    }
    enqueueBlock(request.source, request.block, request.priority, owner);
  }
  if (next.size > 0) {
    ownerBlocks.set(
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

function pump(): void {
  waveformFetchGate.setQueued("pcm", queue.size);
  for (const priority of [
    PRIORITY_VISIBLE,
    PRIORITY_OVERSCAN,
    PRIORITY_PREFETCH,
  ]) {
    const bucket = priorityBuckets.get(priority)!;
    while (bucket.size > 0) {
      const id = bucket.values().next().value;
      if (id === undefined) {
        break;
      }
      const block = queue.get(id);
      if (!block) {
        bucket.delete(id);
        continue;
      }
      if (!waveformFetchGate.tryAcquire(fetchLimit(block.projectPath), "pcm")) {
        return;
      }
      queue.delete(id);
      bucket.delete(id);
      waveformFetchGate.setQueued("pcm", queue.size);
      dispatch(id, block);
    }
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
      listeners.notify(block.key);
    })
    .catch((err: unknown) => {
      if (request.controller.signal.aborted) {
        return;
      }
      const failure = classifyFetchFailure(err);
      if (failure.kind === "stale" || failure.kind === "missing") {
        refreshWaveformStatus(block.projectPath, refKind(block.ref));
      }
      // Hold the block back: a 429 or busy 503 until Retry-After (then re-queue it), anything else briefly.
      cooling.add(id);
      const retry = {
        projectPath: block.projectPath,
        id,
        timer: setTimeout(() => {
          retries.delete(retry);
          cooling.delete(id);
          if (
            failure.kind === "retry" &&
            !data.has(id) &&
            !inflight.has(id) &&
            !queue.has(id)
          ) {
            refreshBlockOwners(block, id);
            if (
              block.owners.size === 0 &&
              (block.basePriority === null ||
                block.baseSource?.projectPath !== retry.projectPath)
            ) {
              pump();
              return;
            }
            requeueBlock(block, id);
          }
          pump();
        }, holdBackMs(failure)),
      };
      retries.add(retry);
    })
    .finally(() => {
      requests.delete(request);
      inflight.delete(id);
      if (
        request.controller.signal.aborted &&
        !data.has(id) &&
        !queue.has(id)
      ) {
        requeueBlock(block, id, false);
        waveformFetchGate.setQueued("pcm", queue.size);
      }
      waveformFetchGate.release("pcm");
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
      priorityBuckets.get(block.priority)!.delete(id);
    }
  }
  for (const retry of [...retries]) {
    if (retry.projectPath !== projectPath) {
      const kept = [...ownerBlocks.values()].some(
        (owned) => owned.get(retry.id)?.source.projectPath === projectPath,
      );
      if (kept) {
        retry.projectPath = projectPath;
        continue;
      }
      clearTimeout(retry.timer);
      cooling.delete(retry.id);
      retries.delete(retry);
    }
  }
  for (const [owner, owned] of ownerBlocks) {
    for (const [id, interest] of owned) {
      if (interest.source.projectPath !== projectPath) {
        owned.delete(id);
        const queued = queue.get(id);
        if (queued) {
          refreshBlockOwners(queued, id);
          if (queued.basePriority === null && queued.owners.size === 0) {
            queue.delete(id);
            priorityBuckets.get(queued.priority)!.delete(id);
          } else {
            moveBlockPriority(queued, effectivePriority(queued));
          }
        }
      }
    }
    if (owned.size === 0) {
      ownerBlocks.delete(owner);
    }
  }
  pump();
}

/** Drop everything (tests). */
export function resetPcmStore(): void {
  retainPcm("\u0000none");
  data.clear();
  ownerBlocks.clear();
  listeners.clear();
}
