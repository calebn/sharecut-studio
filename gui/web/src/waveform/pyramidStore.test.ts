import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaveformFetchError } from "../api";
import { waveformFetchGate } from "./budgets";
import type { PyramidMeta } from "./types";

type Call = {
  projectPath: string;
  req: {
    key: string;
    ref: string;
    level: number;
    start: number;
    count: number;
  };
  signal: AbortSignal;
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: unknown) => void;
};

const calls = vi.hoisted(() => [] as Call[]);
const status = vi.hoisted(() => ({
  noteWaveformTileMissing: vi.fn(),
  readyListener: null as null | ((p: string, r: string, m: unknown) => void),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadWaveformTiles: (
    projectPath: string,
    req: Call["req"],
    signal: AbortSignal,
  ) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      calls.push({ projectPath, req, signal, resolve, reject });
    }),
}));
vi.mock("./statusStore", () => ({
  noteWaveformTileMissing: status.noteWaveformTileMissing,
  onWaveformReady: (fn: (p: string, r: string, m: unknown) => void) => {
    status.readyListener = fn;
    return () => {};
  },
}));

const {
  getBins,
  hasBins,
  hasTile,
  prefetchPyramid,
  PRIORITY_OVERSCAN,
  PRIORITY_PREFETCH,
  PRIORITY_VISIBLE,
  pyramidBytes,
  requestTiles,
  resetPyramidStore,
  retainPyramids,
  subscribePyramid,
} = await import("./pyramidStore");

/** Four levels: 40, 10, 3 and 1 data tiles of 4 bins each. */
const meta: PyramidMeta = {
  key: "k".repeat(20),
  sample_rate: 48000,
  channels: 1,
  total_frames: 160 * 64,
  base_spp: 64,
  level_factor: 4,
  bins_per_tile: 4,
  levels: [
    { spp: 64, bins: 160 },
    { spp: 256, bins: 40 },
    { spp: 1024, bins: 10 },
    { spp: 4096, bins: 3 },
  ],
};
const source = { projectPath: "/tmp/p.json", ref: "track:host", meta };

/** Bins for data tiles `[start, start+count)` of a level; bin i is (-i, i, i). */
function tileBytes(level: number, start: number, count: number): ArrayBuffer {
  const lvlBins = meta.levels[level]!.bins;
  const from = start * 4;
  const to = Math.min(lvlBins, (start + count) * 4);
  const out = new Int16Array((to - from) * 3);
  for (let i = from; i < to; i++) {
    out.set([-i, i, i], (i - from) * 3);
  }
  return out.buffer;
}

function answer(call: Call): void {
  call.resolve(tileBytes(call.req.level, call.req.start, call.req.count));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function drain(): Promise<void> {
  while (calls.length) {
    answer(calls.shift()!);
    await flush();
  }
}

describe("pyramidStore", () => {
  beforeEach(() => {
    calls.length = 0;
    status.noteWaveformTileMissing.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await drain();
    resetPyramidStore();
    expect(waveformFetchGate.active).toBe(0);
  });

  it("coalesces missing tiles into runs of max_tiles_per_request", async () => {
    requestTiles(
      source,
      0,
      Array.from({ length: 21 }, (_, i) => i),
      PRIORITY_VISIBLE,
    );
    expect(calls.map((c) => [c.req.start, c.req.count])).toEqual([
      [0, 16],
      [16, 5],
    ]);
    expect(calls[0]!.req).toMatchObject({
      key: meta.key,
      ref: "track:host",
      level: 0,
    });
  });

  it("dedupes queued, in-flight and loaded tiles", async () => {
    requestTiles(source, 1, [0, 1], PRIORITY_VISIBLE);
    requestTiles(source, 1, [0, 1], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(1);
    answer(calls.shift()!);
    await flush();
    expect(hasTile(meta.key, 1, 1)).toBe(true);
    requestTiles(source, 1, [0, 1], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(0);
  });

  it("serves visible before overscan before prefetch when slots free", async () => {
    // Fill the 4 host slots.
    requestTiles(source, 0, [0], PRIORITY_VISIBLE);
    requestTiles(source, 0, [2], PRIORITY_VISIBLE);
    requestTiles(source, 0, [4], PRIORITY_VISIBLE);
    requestTiles(source, 0, [6], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(4);
    requestTiles(source, 2, [0], PRIORITY_PREFETCH);
    requestTiles(source, 1, [5], PRIORITY_OVERSCAN);
    requestTiles(source, 0, [30], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(4);
    answer(calls.shift()!);
    await flush();
    expect(calls.at(-1)!.req).toMatchObject({ level: 0, start: 30 });
    answer(calls.shift()!);
    await flush();
    expect(calls.at(-1)!.req).toMatchObject({ level: 1, start: 5 });
    answer(calls.shift()!);
    await flush();
    expect(calls.at(-1)!.req).toMatchObject({ level: 2, start: 0 });
  });

  it("upgrades a queued tile's priority", async () => {
    for (const t of [0, 2, 4, 6]) {
      requestTiles(source, 0, [t], PRIORITY_VISIBLE);
    }
    requestTiles(source, 1, [3], PRIORITY_PREFETCH);
    requestTiles(source, 2, [1], PRIORITY_OVERSCAN);
    requestTiles(source, 1, [3], PRIORITY_VISIBLE);
    answer(calls.shift()!);
    await flush();
    expect(calls.at(-1)!.req).toMatchObject({ level: 1, start: 3 });
  });

  it("never aborts on zoom or scroll; only leaving the project does", async () => {
    requestTiles(source, 0, [0], PRIORITY_VISIBLE);
    // A zoom asks another level, a scroll other tiles.
    requestTiles(source, 2, [0, 1], PRIORITY_VISIBLE);
    requestTiles(source, 0, [20], PRIORITY_VISIBLE);
    expect(calls.every((c) => !c.signal.aborted)).toBe(true);
    retainPyramids("/tmp/p.json");
    expect(calls.every((c) => !c.signal.aborted)).toBe(true);
    retainPyramids("/tmp/other.json");
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
  });

  it("re-queues after Retry-After on 429", async () => {
    vi.useFakeTimers();
    requestTiles(source, 1, [2], PRIORITY_VISIBLE);
    calls.shift()!.reject(new WaveformFetchError(429, 2));
    await flush();
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1999);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req).toMatchObject({ level: 1, start: 2, count: 1 });
  });

  it("asks for a status refresh on 404 and allows a later retry", async () => {
    requestTiles(source, 1, [2], PRIORITY_VISIBLE);
    calls.shift()!.reject(new WaveformFetchError(404, null));
    await flush();
    expect(status.noteWaveformTileMissing).toHaveBeenCalledWith(
      "/tmp/p.json",
      "track:host",
      meta.key,
    );
    requestTiles(source, 1, [2], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(1);
  });

  it("returns copies of loaded bins, missing ones with rms -1", async () => {
    const seen = vi.fn();
    const off = subscribePyramid(meta.key, seen);
    requestTiles(source, 1, [1, 2], PRIORITY_VISIBLE);
    answer(calls.shift()!);
    await flush();
    expect(seen).toHaveBeenCalledOnce();
    off();
    expect(hasBins(meta, 1, 4, 8)).toBe(true);
    expect(hasBins(meta, 1, 2, 8)).toBe(false);
    const bins = getBins(meta, 1, 2, 8);
    expect([...bins.subarray(0, 6)]).toEqual([0, 0, -1, 0, 0, -1]);
    expect([...bins.subarray(6, 9)]).toEqual([-4, 4, 4]);
    expect([...bins.subarray(21, 24)]).toEqual([-9, 9, 9]);
    bins[6] = 99;
    expect(getBins(meta, 1, 4, 1)[0]).toBe(-4);
    expect(pyramidBytes()).toBe(8 * 3 * 2);
  });

  it("prefetches the coarsest level and small next levels on ready", () => {
    expect(status.readyListener).toBeTypeOf("function");
    status.readyListener!("/tmp/p.json", "track:host", meta);
    // Levels 3 (1 tile) and 2 (3 tiles); level 1 (10 tiles) is too big.
    expect(calls.map((c) => [c.req.level, c.req.start, c.req.count])).toEqual([
      [3, 0, 1],
      [2, 0, 3],
    ]);
  });

  it("skips tiles outside the level", () => {
    prefetchPyramid({
      ...source,
      meta: { ...meta, levels: [{ spp: 64, bins: 0 }] },
    });
    requestTiles(source, 3, [-1, 5], PRIORITY_VISIBLE);
    expect(calls).toHaveLength(0);
  });
});
