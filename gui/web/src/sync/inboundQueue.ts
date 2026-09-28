import { batchDawWrites } from "../state/dawStore";

/**
 * One inbound realtime queue per animation frame. Every WS `onmessage`
 * handler enqueues its work here instead of writing to the store directly;
 * the queue drains once per rAF (or once per `setTimeout(0)` while the tab is
 * hidden, since a hidden tab's rAF never fires), running every queued job
 * inside one `batchDawWrites` so N frames received between paints commit as
 * one render instead of N.
 *
 * `coalesceKey` lets a newer job of the same kind replace an older, still
 * unflushed one in place (a newer full Presence roster drops the older
 * queued one) instead of running both.
 */
export type EnqueueOptions = { coalesceKey?: string };

type Job = { run: () => void; coalesceKey?: string };

let queue: Job[] = [];
let scheduled = false;
let usingTimeout = false;
let rafHandle = 0;
let timeoutHandle: ReturnType<typeof setTimeout> | number = 0;
let flushing = false;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

function runFlush(): void {
  scheduled = false;
  flushInbound();
}

function scheduleFlush(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  if (isHidden()) {
    usingTimeout = true;
    timeoutHandle = setTimeout(runFlush, 0);
  } else {
    usingTimeout = false;
    rafHandle = requestAnimationFrame(runFlush);
  }
}

function cancelScheduled(): void {
  if (!scheduled) {
    return;
  }
  if (usingTimeout) {
    clearTimeout(timeoutHandle as ReturnType<typeof setTimeout>);
  } else {
    cancelAnimationFrame(rafHandle);
  }
  scheduled = false;
}

/** A pending rAF flush switches to a timeout the moment the tab goes hidden. */
function onVisibilityChange(): void {
  if (scheduled && !usingTimeout && isHidden()) {
    cancelScheduled();
    scheduleFlush();
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/** Queues `run` for the next flush; a matching `coalesceKey` replaces the pending job in place. */
export function enqueueInbound(
  run: () => void,
  opts: EnqueueOptions = {},
): void {
  if (opts.coalesceKey) {
    const idx = queue.findIndex((job) => job.coalesceKey === opts.coalesceKey);
    if (idx >= 0) {
      queue[idx] = { run, coalesceKey: opts.coalesceKey };
      scheduleFlush();
      return;
    }
  }
  queue.push({ run, coalesceKey: opts.coalesceKey });
  scheduleFlush();
}

/** Jobs currently queued, unflushed. */
export function pendingInboundCount(): number {
  return queue.length;
}

/**
 * Runs every queued job now, inside one `batchDawWrites` commit.
 * Re-entrancy-guarded: a job that (directly or indirectly) calls this again
 * — or the scheduled callback firing while a caller already flushed
 * synchronously — is a no-op, so jobs never run twice and the loop below
 * never recurses.
 */
export function flushInbound(): void {
  if (flushing) {
    // Leave any flush a job scheduled mid-drain armed: its jobs run next frame.
    return;
  }
  cancelScheduled();
  const jobs = queue;
  queue = [];
  if (jobs.length === 0) {
    return;
  }
  flushing = true;
  try {
    batchDawWrites(() => {
      for (const job of jobs) {
        try {
          job.run();
        } catch (err) {
          // Don't let one bad frame drop the rest of the batch; surface the
          // error asynchronously instead, same as an uncaught promise would.
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    });
  } finally {
    flushing = false;
  }
}

/** Test-only: drops all pending state so tests don't leak into each other. */
export function resetInboundQueueForTests(): void {
  cancelScheduled();
  queue = [];
  flushing = false;
}
