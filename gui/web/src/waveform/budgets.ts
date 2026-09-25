import { WaveformFetchError } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";

const MB = 1024 * 1024;

/** Client budgets (S8). The phone shell gets the smaller caches. */
export const WAVEFORM_BUDGETS = {
  desktop: { bitmapBytes: 128 * MB, tileBytes: 64 * MB, pcmBytes: 32 * MB },
  phone: { bitmapBytes: 48 * MB, tileBytes: 32 * MB, pcmBytes: 32 * MB },
} as const;

export type WaveformBudget = (typeof WAVEFORM_BUDGETS)["desktop"];

/** Budget for the current shell, read at call time (evictions are rare). */
export function waveformBudget(): WaveformBudget {
  return useDawStore.getState().shellBreakpoint === "phone"
    ? WAVEFORM_BUDGETS.phone
    : WAVEFORM_BUDGETS.desktop;
}

/** Waveform fetches in flight: 4 against the host, 3 through a share. */
export function fetchLimit(projectPath: string): number {
  return isShareProjectKey(projectPath) ? 3 : 4;
}

/** Raster jobs outstanding in the worker. */
export const RASTER_JOBS_OUTSTANDING = 4;

/**
 * One counter of waveform fetches in flight, shared by tiles and PCM so
 * together they stay within {@link fetchLimit}.
 */
export class FetchGate {
  private inflight = 0;
  private readonly waiters = new Set<() => void>();

  get active(): number {
    return this.inflight;
  }

  /** Take a slot if one is free under `limit`. */
  tryAcquire(limit: number): boolean {
    if (this.inflight >= limit) {
      return false;
    }
    this.inflight += 1;
    return true;
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  /** Called whenever a slot frees; returns an unsubscribe. */
  onRelease(wake: () => void): () => void {
    this.waiters.add(wake);
    return () => this.waiters.delete(wake);
  }
}

export const waveformFetchGate = new FetchGate();

/**
 * Least-recently-used map with a byte budget. `onEvict` runs for every value
 * pushed out (bitmaps are closed there).
 */
export class ByteLru<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private total = 0;
  private readonly budget: () => number;
  private readonly onEvict: (key: string, value: V) => void;

  constructor(
    budget: () => number,
    onEvict: (key: string, value: V) => void = () => {},
  ) {
    this.budget = budget;
    this.onEvict = onEvict;
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** The value, marked most recently used. */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /** The value without touching recency. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    this.map.set(key, { value, bytes });
    this.total += bytes;
    this.trim();
  }

  delete(key: string): boolean {
    const hit = this.map.get(key);
    if (!hit) {
      return false;
    }
    this.map.delete(key);
    this.total -= hit.bytes;
    this.onEvict(key, hit.value);
    return true;
  }

  /** Oldest first. */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  entries(): IterableIterator<[string, V]> {
    const it = this.map.entries();
    return (function* () {
      for (const [k, v] of it) {
        yield [k, v.value] as [string, V];
      }
    })();
  }

  /** Evict least recently used values until the budget holds. */
  trim(): void {
    const budget = this.budget();
    for (const key of this.map.keys()) {
      if (this.total <= budget) {
        return;
      }
      this.delete(key);
    }
  }

  clear(): void {
    for (const key of [...this.map.keys()]) {
      this.delete(key);
    }
  }
}

/** How to treat a failed waveform fetch. */
export type FetchFailure =
  | { kind: "retry"; afterMs: number }
  | { kind: "missing" }
  | { kind: "stale" }
  | { kind: "drop" };

/**
 * 429 re-queues after `Retry-After` (1 s without one); 404 means the key or
 * ref is gone; 409 means the PCM key is stale; anything else is dropped (the
 * next request for the same data tries again).
 */
export function classifyFetchFailure(err: unknown): FetchFailure {
  if (!(err instanceof WaveformFetchError)) {
    return { kind: "drop" };
  }
  if (err.status === 429) {
    return { kind: "retry", afterMs: (err.retryAfterSec ?? 1) * 1000 };
  }
  if (err.status === 404) {
    return { kind: "missing" };
  }
  if (err.status === 409) {
    return { kind: "stale" };
  }
  return { kind: "drop" };
}
