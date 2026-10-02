import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaveformFetchError } from "../api";
import { PCM_BLOCK_FRAMES } from "../utils/timelineZoom.generated";
import { FAILED_FETCH_BACKOFF_MS, waveformFetchGate } from "./budgets";
import type { PyramidMeta } from "./types";

type Call = {
  projectPath: string;
  req: { key: string; ref: string; block: number };
  signal: AbortSignal;
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: unknown) => void;
};

type TileCall = {
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
const tileCalls = vi.hoisted(() => [] as TileCall[]);
const refresh = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadWaveformPcm: (
    projectPath: string,
    req: Call["req"],
    signal: AbortSignal,
  ) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      calls.push({ projectPath, req, signal, resolve, reject });
    }),
  loadWaveformTiles: (
    projectPath: string,
    req: TileCall["req"],
    signal: AbortSignal,
  ) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      tileCalls.push({ projectPath, req, signal, resolve, reject });
    }),
}));
vi.mock("./statusStore", () => ({
  refreshWaveformStatus: refresh,
  noteWaveformTileMissing: vi.fn(),
  onWaveformReady: () => () => {},
}));

const { PRIORITY_OVERSCAN, PRIORITY_VISIBLE, requestTiles, resetPyramidStore } =
  await import("./pyramidStore");

const {
  getPcm,
  MAX_PCM_BLOCKS_PER_REQUEST,
  replacePcmRequests,
  requestPcm,
  resetPcmStore,
  retainPcm,
  subscribePcm,
} = await import("./pcmStore");

const KEY = "p".repeat(20);
const source = { projectPath: "/tmp/p.json", ref: "track:host", key: KEY };
const tileMeta: PyramidMeta = {
  key: "t".repeat(20),
  sample_rate: 48000,
  channels: 1,
  total_frames: 100,
  base_spp: 1,
  level_factor: 4,
  bins_per_tile: 1,
  levels: [{ spp: 1, bins: 100 }],
};
const tileSource = {
  projectPath: source.projectPath,
  ref: source.ref,
  meta: tileMeta,
};

/** Block `b`: frame f is (-f % 1000, f % 1000); the last block may be short. */
function blockBytes(b: number, frames = PCM_BLOCK_FRAMES): ArrayBuffer {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const f = b * PCM_BLOCK_FRAMES + i;
    out[i * 2] = -(f % 1000);
    out[i * 2 + 1] = f % 1000;
  }
  return out.buffer;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("pcmStore", () => {
  it("wakes when another store frees a gate slot", () => {
    for (let i = 0; i < 4; i++) {
      expect(waveformFetchGate.tryAcquire(4)).toBe(true);
    }
    requestPcm(source, 3, 3);
    expect(calls).toHaveLength(0);
    waveformFetchGate.release();
    expect(calls.map((c) => c.req.block)).toEqual([3]);
    for (let i = 0; i < 3; i++) {
      waveformFetchGate.release();
    }
  });

  beforeEach(() => {
    calls.length = 0;
    tileCalls.length = 0;
    refresh.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (calls.length || tileCalls.length) {
      while (calls.length) {
        const call = calls.shift()!;
        call.resolve(blockBytes(call.req.block));
      }
      while (tileCalls.length) {
        tileCalls.shift()!.resolve(new Int16Array(3).buffer);
      }
      await flush();
    }
    resetPyramidStore();
    resetPcmStore();
    expect(waveformFetchGate.active).toBe(0);
  });

  it("requests whole blocks once and serves copies across them", async () => {
    const seen = vi.fn();
    subscribePcm(KEY, seen);
    requestPcm(source, 0, 1);
    requestPcm(source, 0, 1);
    expect(calls.map((c) => c.req.block)).toEqual([0, 1]);
    expect(getPcm(KEY, 65530, 10, 1e6)).toBeNull();
    calls.shift()!.resolve(blockBytes(0));
    calls.shift()!.resolve(blockBytes(1));
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    const got = getPcm(KEY, 65530.5, 10, 1e6)!;
    expect(got.pcmStart).toBe(65530);
    expect(got.pcm.length).toBe(12 * 2);
    expect([...got.pcm.subarray(0, 2)]).toEqual([-530, 530]);
    expect([...got.pcm.subarray(22, 24)]).toEqual([-541, 541]);
    got.pcm[0] = 7;
    expect(getPcm(KEY, 65530, 1, 1e6)!.pcm[0]).toBe(-530);
  });

  it("clips at the end of the media", async () => {
    requestPcm(source, 0, 0);
    calls.shift()!.resolve(blockBytes(0, 100));
    await flush();
    expect(getPcm(KEY, 90, 50, 100)!.pcm.length).toBe(10 * 2);
    expect(getPcm(KEY, 200, 5, 100)).toBeNull();
    // A short block that should be full is not served.
    expect(getPcm(KEY, 90, 50, 1e6)).toBeNull();
  });

  it("never asks for guest PCM", () => {
    requestPcm({ ...source, projectPath: "share:tok" }, 0, 3);
    expect(calls).toHaveLength(0);
  });

  it("caps one requested PCM range", async () => {
    const requested: number[] = [];
    requestPcm(source, 0, 500);
    while (calls.length) {
      const call = calls.shift()!;
      requested.push(call.req.block);
      call.resolve(blockBytes(call.req.block));
      await flush();
    }
    expect(requested).toHaveLength(MAX_PCM_BLOCKS_PER_REQUEST);
    expect(requested[0]).toBe(0);
    expect(requested.at(-1)).toBe(MAX_PCM_BLOCKS_PER_REQUEST - 1);
  });

  it("replaces stale queued PCM blocks and keeps visible blocks ahead", () => {
    for (let i = 0; i < 4; i++) {
      expect(waveformFetchGate.tryAcquire(4)).toBe(true);
    }
    replacePcmRequests("layer", [
      { source, b0: 0, b1: 3, priority: PRIORITY_OVERSCAN },
    ]);
    replacePcmRequests("layer", [
      { source, b0: 8, b1: 9, priority: PRIORITY_VISIBLE },
    ]);
    waveformFetchGate.release();
    expect(calls.map((call) => call.req.block)).toEqual([8]);
    for (let i = 0; i < 3; i++) {
      waveformFetchGate.release();
    }
  });

  it("does not retry a failed PCM block after its view owner leaves", async () => {
    vi.useFakeTimers();
    replacePcmRequests("layer", [
      { source, b0: 4, b1: 4, priority: PRIORITY_VISIBLE },
    ]);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    replacePcmRequests("layer", []);
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0);
  });

  it("keeps a second layer's interest when a shared in-flight PCM block retries", async () => {
    vi.useFakeTimers();
    replacePcmRequests("first", [
      { source, b0: 4, b1: 4, priority: PRIORITY_VISIBLE },
    ]);
    replacePcmRequests("second", [
      {
        source: { ...source, projectPath: "/tmp/q.json" },
        b0: 4,
        b1: 4,
        priority: PRIORITY_VISIBLE,
      },
    ]);
    replacePcmRequests("first", []);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(calls.map((call) => call.req.block)).toEqual([4]);
    expect(calls[0]!.projectPath).toBe("/tmp/q.json");
  });

  it("keeps a retrying PCM block alive when retention switches to its cooling owner", async () => {
    vi.useFakeTimers();
    replacePcmRequests("first", [
      { source, b0: 4, b1: 4, priority: PRIORITY_VISIBLE },
    ]);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    replacePcmRequests("second", [
      {
        source: { ...source, projectPath: "/tmp/q.json" },
        b0: 4,
        b1: 4,
        priority: PRIORITY_VISIBLE,
      },
    ]);
    retainPcm("/tmp/q.json");
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projectPath).toBe("/tmp/q.json");
  });

  it("retains a kept project's interest in an in-flight PCM block through retry", async () => {
    vi.useFakeTimers();
    replacePcmRequests("layer", [
      { source, b0: 6, b1: 6, priority: PRIORITY_VISIBLE },
    ]);
    retainPcm(source.projectPath);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.block).toBe(6);
  });

  it("requeues an aborted in-flight PCM block for its remaining project owner", async () => {
    replacePcmRequests("first", [
      { source, b0: 8, b1: 8, priority: PRIORITY_VISIBLE },
    ]);
    replacePcmRequests("second", [
      {
        source: { ...source, projectPath: "/tmp/q.json" },
        b0: 8,
        b1: 8,
        priority: PRIORITY_VISIBLE,
      },
    ]);
    retainPcm("/tmp/q.json");
    expect(calls[0]!.signal.aborted).toBe(true);
    calls.shift()!.reject(new Error("aborted"));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projectPath).toBe("/tmp/q.json");
    expect(calls[0]!.req.block).toBe(8);
  });

  it("dispatches visible PCM blocks before overscan blocks", () => {
    for (let i = 0; i < 4; i++) {
      expect(waveformFetchGate.tryAcquire(4)).toBe(true);
    }
    requestPcm(source, 90, 90, PRIORITY_OVERSCAN);
    requestPcm(source, 5, 5, PRIORITY_VISIBLE);
    waveformFetchGate.release();
    expect(calls.map((call) => call.req.block)).toEqual([5]);
    for (let i = 0; i < 3; i++) {
      waveformFetchGate.release();
    }
  });

  it("reserves a gate slot for PCM while tile requests are queued", async () => {
    requestTiles(tileSource, 0, [0, 2, 4, 6], PRIORITY_VISIBLE);
    expect(tileCalls).toHaveLength(4);
    requestTiles(tileSource, 0, [8], PRIORITY_VISIBLE);
    requestPcm(source, 7, 7);
    expect(calls).toHaveLength(0);
    tileCalls.shift()!.resolve(new Int16Array(3).buffer);
    await flush();
    expect(calls.map((call) => call.req.block)).toEqual([7]);
    expect(tileCalls.some((call) => call.req.start === 8)).toBe(false);
  });

  it("refreshes status on a stale key (409)", async () => {
    requestPcm({ ...source, ref: "stem:host" }, 2, 2);
    calls.shift()!.reject(new WaveformFetchError(409, null));
    await flush();
    expect(refresh).toHaveBeenCalledWith("/tmp/p.json", "stem");
    requestPcm({ ...source, ref: "stem:host" }, 2, 2);
    expect(calls).toHaveLength(0);
  });

  it("holds a failed block back briefly without re-queueing it", async () => {
    vi.useFakeTimers();
    requestPcm(source, 5, 5);
    calls.shift()!.reject(new WaveformFetchError(500, null));
    await flush();
    requestPcm(source, 5, 5);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(FAILED_FETCH_BACKOFF_MS);
    expect(calls).toHaveLength(0);
    requestPcm(source, 5, 5);
    expect(calls.map((c) => c.req.block)).toEqual([5]);
  });

  it("hands a queued block to the project that asked last", async () => {
    requestPcm(source, 0, 3);
    requestPcm(source, 9, 9);
    requestPcm({ ...source, projectPath: "/tmp/q.json" }, 9, 9);
    retainPcm("/tmp/q.json");
    calls.shift()!.resolve(new ArrayBuffer(0));
    await flush();
    expect(calls.at(-1)!.projectPath).toBe("/tmp/q.json");
    expect(calls.at(-1)!.req.block).toBe(9);
  });

  it("re-queues after Retry-After on 429", async () => {
    vi.useFakeTimers();
    requestPcm(source, 4, 4);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    requestPcm(source, 4, 4);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(calls.map((c) => c.req.block)).toEqual([4]);
  });

  it("re-queues after Retry-After on a busy 503", async () => {
    vi.useFakeTimers();
    requestPcm(source, 5, 5);
    calls.shift()!.reject(new WaveformFetchError(503, 1));
    await flush();
    requestPcm(source, 5, 5);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(calls.map((c) => c.req.block)).toEqual([5]);
  });

  it("aborts only when leaving the project", () => {
    requestPcm(source, 0, 0);
    retainPcm("/tmp/p.json");
    expect(calls[0]!.signal.aborted).toBe(false);
    retainPcm("/tmp/other.json");
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});
