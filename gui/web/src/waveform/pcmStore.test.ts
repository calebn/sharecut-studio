import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaveformFetchError } from "../api";
import { PCM_BLOCK_FRAMES } from "../utils/timelineZoom.generated";
import { waveformFetchGate } from "./budgets";

type Call = {
  projectPath: string;
  req: { key: string; ref: string; block: number };
  signal: AbortSignal;
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: unknown) => void;
};

const calls = vi.hoisted(() => [] as Call[]);
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
}));
vi.mock("./statusStore", () => ({ refreshWaveformStatus: refresh }));

const { getPcm, requestPcm, resetPcmStore, retainPcm, subscribePcm } =
  await import("./pcmStore");

const KEY = "p".repeat(20);
const source = { projectPath: "/tmp/p.json", ref: "track:host", key: KEY };

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
  beforeEach(() => {
    calls.length = 0;
    refresh.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (calls.length) {
      calls.shift()!.resolve(new ArrayBuffer(0));
      await flush();
    }
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

  it("refreshes status on a stale key (409)", async () => {
    requestPcm({ ...source, ref: "stem:host" }, 2, 2);
    calls.shift()!.reject(new WaveformFetchError(409, null));
    await flush();
    expect(refresh).toHaveBeenCalledWith("/tmp/p.json", "stem");
  });

  it("re-queues after Retry-After on 429", async () => {
    vi.useFakeTimers();
    requestPcm(source, 4, 4);
    calls.shift()!.reject(new WaveformFetchError(429, 1));
    await flush();
    vi.advanceTimersByTime(1000);
    expect(calls.map((c) => c.req.block)).toEqual([4]);
  });

  it("aborts only when leaving the project", () => {
    requestPcm(source, 0, 0);
    retainPcm("/tmp/p.json");
    expect(calls[0]!.signal.aborted).toBe(false);
    retainPcm("/tmp/other.json");
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});
