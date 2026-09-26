import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doneMsg,
  FakeRasterWorker,
  fakeBitmap,
  rasterRequest,
  stubRasterWorker,
} from "../test/waveform";
import { bitmapCache } from "./bitmapCache";
import {
  RASTER_JOB_RETRIES,
  RASTER_RESTART_REARM_TILES,
  RASTER_WORKER_RESTARTS,
} from "./budgets";
import {
  crashRasterWorker,
  getRasterBackend,
  hasRaster,
  rasterParity,
  rasterTilesByMode,
  rasterTilesRendered,
  rasterWorkerRestarts,
  requestRaster,
  resetRasterClient,
  startRasterWorker,
  subscribeRasterBackend,
  subscribeRasterDone,
  subscribeRasterDropped,
  subscribeRasterFailed,
} from "./rasterClient";
import { parityJob } from "./rasterProtocol";

const req = rasterRequest;
const bitmap = () => fakeBitmap();

describe("rasterClient without Worker (jsdom)", () => {
  afterEach(() => {
    resetRasterClient();
  });

  it("reports backend none and renders nothing", async () => {
    expect(getRasterBackend()).toBe("none");
    requestRaster(req("a"));
    await expect(rasterParity()).resolves.toBeNull();
    expect(rasterTilesRendered()).toBe(0);
  });
});

describe("rasterClient", () => {
  beforeEach(() => {
    stubRasterWorker();
  });

  afterEach(() => {
    resetRasterClient();
    bitmapCache.clear();
    vi.unstubAllGlobals();
  });

  it("frees the slot when postMessage throws", () => {
    startRasterWorker();
    const w = FakeRasterWorker.last!;
    const real = w.postMessage.bind(w);
    w.postMessage = () => {
      throw new DOMException("detached", "DataCloneError");
    };
    for (const k of ["a", "b", "c", "d"]) {
      expect(() => requestRaster(req(k))).not.toThrow();
    }
    w.postMessage = real;
    requestRaster(req("e"));
    expect(w.posted).toHaveLength(1);
  });

  it("closes a finished bitmap whose job is gone", () => {
    startRasterWorker();
    const close = vi.fn();
    FakeRasterWorker.last!.reply({
      type: "done",
      id: 99,
      bitmap: { close } as unknown as ImageBitmap,
      backend: "webgl2",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(rasterTilesRendered()).toBe(0);
  });

  it("does not hand listeners a bitmap evicted on insert", () => {
    const done = vi.fn();
    subscribeRasterDone(done);
    requestRaster(
      req("huge", { job: { ...parityJob(), cols: 8192, rows: 8192 } }),
    );
    const close = vi.fn();
    FakeRasterWorker.last!.reply({
      type: "done",
      id: 1,
      bitmap: { close } as unknown as ImageBitmap,
      backend: "webgl2",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });

  it("settles pending parity with null on reset", async () => {
    const p = rasterParity();
    resetRasterClient();
    await expect(p).resolves.toBeNull();
  });

  it("never lets a provisional request replace a queued exact one", () => {
    for (const k of ["a", "b", "c", "d"]) {
      requestRaster(req(k));
    }
    requestRaster(req("x"));
    requestRaster(req("x", { provisional: true }));
    const w = FakeRasterWorker.last!;
    w.reply({ type: "done", id: 1, bitmap: bitmap(), backend: "webgl2" });
    expect(w.posted).toHaveLength(5);
    w.reply({ type: "done", id: 5, bitmap: bitmap(), backend: "webgl2" });
    expect(bitmapCache.get("x")).toBeDefined();
  });

  it("starts a module worker lazily and takes its backend", () => {
    expect(getRasterBackend()).toBe("starting");
    expect(FakeRasterWorker.last).toBeNull();
    const seen = vi.fn();
    const off = subscribeRasterBackend(seen);
    startRasterWorker();
    const w = FakeRasterWorker.last!;
    expect(w.opts).toEqual({ type: "module" });
    expect(w.url.pathname).toMatch(/raster\.worker\.ts$/);
    w.reply({ type: "ready", backend: "webgl2" });
    expect(getRasterBackend()).toBe("webgl2");
    expect(seen).toHaveBeenCalledOnce();
    off();
  });

  it("keeps 4 jobs outstanding, transfers bins, and drops unwanted jobs", () => {
    let wantE = true;
    for (const k of ["a", "b", "c", "d"]) {
      requestRaster(req(k));
    }
    requestRaster(req("e", { wanted: () => wantE, priority: 1 }));
    requestRaster(req("f", { priority: 0 }));
    const w = FakeRasterWorker.last!;
    expect(w.posted).toHaveLength(4);
    const first = w.posted[0]!;
    expect(first.msg.type).toBe("render");
    if (
      first.msg.type === "render" &&
      first.msg.job.source.kind === "pyramid"
    ) {
      expect(first.transfer).toEqual([first.msg.job.source.bins.buffer]);
    }
    // A slot frees: f (priority 0) goes before e.
    w.reply({ type: "done", id: 1, bitmap: bitmap(), backend: "webgl2" });
    expect(w.posted).toHaveLength(5);
    wantE = false;
    w.reply({ type: "done", id: 2, bitmap: bitmap(), backend: "webgl2" });
    // e is no longer wanted: dropped, never sent.
    expect(w.posted).toHaveLength(5);
    expect(rasterTilesRendered()).toBe(2);
    expect(rasterTilesByMode()).toEqual({ pyramid: 2, pcm: 0, line: 0 });
  });

  it("caches results, stale ones too, and provisional ones as stand-ins", () => {
    const done = vi.fn();
    subscribeRasterDone(done);
    let wanted = true;
    requestRaster(req("x", { wanted: () => wanted, tile: 3, zoom: 50 }));
    requestRaster(req("y", { provisional: true }));
    wanted = false;
    const w = FakeRasterWorker.last!;
    const bx = bitmap();
    w.reply({ type: "done", id: 1, bitmap: bx, backend: "cpu-worker" });
    w.reply({ type: "done", id: 2, bitmap: bitmap(), backend: "cpu-worker" });
    expect(getRasterBackend()).toBe("cpu-worker");
    expect(bitmapCache.get("x")).toMatchObject({
      bitmap: bx,
      width: 96,
      height: 57,
      tile: 3,
      zoom: 50,
    });
    expect(bitmapCache.get("y")).toBeUndefined();
    expect(done.mock.calls.map((c) => c[0])).toEqual(["x", "y"]);
  });

  it("dedupes a job already outstanding", () => {
    requestRaster(req("a"));
    requestRaster(req("a"));
    expect(FakeRasterWorker.last!.posted).toHaveLength(1);
  });

  it("asks the worker for parity", async () => {
    const p = rasterParity();
    const w = FakeRasterWorker.last!;
    const msg = w.posted[0]!.msg;
    expect(msg.type).toBe("parity");
    w.reply({ type: "parity", id: msg.id, value: 0.004 });
    await expect(p).resolves.toBe(0.004);
  });

  it("settles parity with null when posting to the worker throws", async () => {
    requestRaster(req("a"));
    const w = FakeRasterWorker.last!;
    vi.spyOn(w, "postMessage").mockImplementation(() => {
      throw new Error("DataCloneError");
    });
    await expect(rasterParity()).resolves.toBeNull();
  });

  const fiveJobs = ["a", "b", "c", "d", "e"];

  it.each(["onerror", "onmessageerror"] as const)(
    "restarts a worker after %s (a lost reply holds its slot), re-sends queued jobs and reports the jobs that died",
    async (handler) => {
      const failed: string[] = [];
      subscribeRasterFailed((k) => failed.push(k));
      startRasterWorker();
      const w = FakeRasterWorker.last!;
      w.reply({ type: "ready", backend: "webgl2" });
      for (const k of fiveJobs) {
        requestRaster(req(k));
      }
      expect(w.posted).toHaveLength(4);
      const parity = rasterParity();
      w[handler]?.();
      expect(w.terminated).toBe(true);
      expect(FakeRasterWorker.last).not.toBe(w);
      expect(FakeRasterWorker.created).toBe(2);
      expect(getRasterBackend()).toBe("webgl2");
      const next = FakeRasterWorker.last!;
      expect(next.posted).toHaveLength(1);
      expect(next.posted[0]!.msg.type).toBe("render");
      expect(failed).toEqual(["a", "b", "c", "d"]);
      await expect(parity).resolves.toBeNull();
      expect(hasRaster("a", false, 0)).toBe(false);
    },
  );

  it("a listener's re-request of a failed key reaches the new worker", () => {
    subscribeRasterFailed((k) => requestRaster(req(k)));
    for (const k of fiveJobs) {
      requestRaster(req(k));
    }
    FakeRasterWorker.last!.onerror?.();
    const next = FakeRasterWorker.last!;
    expect(next.posted).toHaveLength(4);
    expect(hasRaster("d", false, 0)).toBe(true);
  });

  it("gives up after RASTER_WORKER_RESTARTS restarts and reports queued jobs too", async () => {
    const failed: string[] = [];
    subscribeRasterFailed((k) => failed.push(k));
    startRasterWorker();
    for (let i = 0; i < RASTER_WORKER_RESTARTS; i++) {
      FakeRasterWorker.last!.onerror?.();
      expect(getRasterBackend()).not.toBe("none");
    }
    for (const k of fiveJobs) {
      requestRaster(req(k));
    }
    const last = FakeRasterWorker.last!;
    last.onerror?.();
    expect(getRasterBackend()).toBe("none");
    expect(last.terminated).toBe(true);
    expect(FakeRasterWorker.created).toBe(RASTER_WORKER_RESTARTS + 1);
    expect(failed).toEqual(expect.arrayContaining(fiveJobs));
    requestRaster(req("z"));
    expect(FakeRasterWorker.created).toBe(RASTER_WORKER_RESTARTS + 1);
    expect(last.posted).toHaveLength(4);
    await expect(rasterParity()).resolves.toBeNull();
  });

  it("ignores a crash or a late result from a replaced worker", () => {
    requestRaster(req("a"));
    const w = FakeRasterWorker.last!;
    w.onerror?.();
    expect(FakeRasterWorker.created).toBe(2);
    w.onerror?.();
    expect(FakeRasterWorker.created).toBe(2);
    const close = vi.fn();
    w.reply(doneMsg(1, fakeBitmap(close)));
    expect(close).toHaveBeenCalledOnce();
    expect(rasterTilesRendered()).toBe(0);
  });

  it("settles on none at once when the worker cannot be constructed", () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    requestRaster(req("a"));
    expect(getRasterBackend()).toBe("none");
  });

  it("resetRasterClient re-arms the restart budget", () => {
    startRasterWorker();
    for (let i = 0; i <= RASTER_WORKER_RESTARTS; i++) {
      FakeRasterWorker.last!.onerror?.();
    }
    expect(getRasterBackend()).toBe("none");
    resetRasterClient();
    expect(rasterWorkerRestarts()).toBe(0);
    requestRaster(req("a"));
    const before = FakeRasterWorker.created;
    FakeRasterWorker.last!.onerror?.();
    expect(getRasterBackend()).not.toBe("none");
    expect(FakeRasterWorker.created).toBe(before + 1);
  });

  it("keeps pumping after an error reply", () => {
    for (const k of ["a", "b", "c", "d", "e"]) {
      requestRaster(req(k));
    }
    const w = FakeRasterWorker.last!;
    w.reply({ type: "error", id: 1, message: "boom" });
    expect(w.posted).toHaveLength(5);
    expect(rasterTilesRendered()).toBe(0);
  });

  it("reports a render that threw, and retires the key after RASTER_JOB_RETRIES", () => {
    const failed: string[] = [];
    subscribeRasterFailed((k) => {
      failed.push(k);
      requestRaster(req(k));
    });
    requestRaster(req("a"));
    const w = FakeRasterWorker.last!;
    for (let i = 0; i <= RASTER_JOB_RETRIES; i++) {
      w.reply({ type: "error", id: w.posted.at(-1)!.msg.id, message: "boom" });
    }
    expect(failed).toEqual(Array(RASTER_JOB_RETRIES).fill("a"));
    expect(w.posted).toHaveLength(RASTER_JOB_RETRIES + 1);
    expect(hasRaster("a", false, 0)).toBe(true);
    requestRaster(req("a"));
    expect(w.posted).toHaveLength(RASTER_JOB_RETRIES + 1);
    expect(rasterTilesRendered()).toBe(0);
  });

  it("a finished render clears a key's failures", () => {
    subscribeRasterFailed((k) => requestRaster(req(k)));
    requestRaster(req("a"));
    const w = FakeRasterWorker.last!;
    w.reply({ type: "error", id: w.posted.at(-1)!.msg.id, message: "boom" });
    w.reply(doneMsg(w.posted.at(-1)!.msg.id));
    w.reply({ type: "error", id: 99, message: "late" });
    requestRaster(req("a"));
    expect(hasRaster("a", false, 0)).toBe(true);
    w.reply({ type: "error", id: w.posted.at(-1)!.msg.id, message: "boom" });
    // First failure since the success: reported and re-sent, not retired.
    expect(w.posted).toHaveLength(4);
  });

  it("reports a job whose postMessage threw, and retires the key after RASTER_JOB_RETRIES", () => {
    const failed: string[] = [];
    subscribeRasterFailed((k) => {
      failed.push(k);
      requestRaster(req(k));
    });
    startRasterWorker();
    const w = FakeRasterWorker.last!;
    w.postMessage = () => {
      throw new DOMException("detached", "DataCloneError");
    };
    requestRaster(req("a"));
    expect(failed).toEqual(Array(RASTER_JOB_RETRIES).fill("a"));
    expect(hasRaster("a", false, 0)).toBe(true);
  });

  it("retires a key that was in flight at repeated crashes", () => {
    subscribeRasterFailed((k) => requestRaster(req(k)));
    requestRaster(req("poison"));
    for (let i = 0; i <= RASTER_JOB_RETRIES; i++) {
      FakeRasterWorker.last!.onerror?.();
    }
    expect(hasRaster("poison", false, 0)).toBe(true);
    expect(FakeRasterWorker.last!.posted).toHaveLength(0);
    expect(getRasterBackend()).not.toBe("none");
  });

  it("re-arms the restart budget after RASTER_RESTART_REARM_TILES finished tiles", () => {
    startRasterWorker();
    for (let i = 0; i < RASTER_WORKER_RESTARTS; i++) {
      FakeRasterWorker.last!.onerror?.();
    }
    const w = FakeRasterWorker.last!;
    for (let i = 0; i < RASTER_RESTART_REARM_TILES; i++) {
      requestRaster(req(`t${i}`));
      w.reply(doneMsg(w.posted.at(-1)!.msg.id));
    }
    w.onerror?.();
    expect(getRasterBackend()).not.toBe("none");
    expect(FakeRasterWorker.created).toBe(RASTER_WORKER_RESTARTS + 2);
  });

  it("spends one restart when onerror and onmessageerror both fire for one crash", () => {
    startRasterWorker();
    const w = FakeRasterWorker.last!;
    w.onerror?.();
    w.onmessageerror?.();
    expect(FakeRasterWorker.created).toBe(2);
    expect(rasterWorkerRestarts()).toBe(1);
    for (let i = 1; i < RASTER_WORKER_RESTARTS; i++) {
      FakeRasterWorker.last!.onerror?.();
    }
    expect(getRasterBackend()).not.toBe("none");
    expect(FakeRasterWorker.created).toBe(RASTER_WORKER_RESTARTS + 1);
    expect(rasterWorkerRestarts()).toBe(RASTER_WORKER_RESTARTS);
  });

  it("crashRasterWorker restarts the current worker (E2E) and counts it", () => {
    crashRasterWorker();
    expect(FakeRasterWorker.created).toBe(0);
    startRasterWorker();
    crashRasterWorker();
    expect(FakeRasterWorker.created).toBe(2);
    expect(FakeRasterWorker.last!.terminated).toBe(false);
    expect(rasterWorkerRestarts()).toBe(1);
  });

  it("reports a request it would drop as a duplicate", () => {
    for (const k of ["a", "b", "c", "d"]) {
      requestRaster(req(k));
    }
    expect(hasRaster("a", false, 0)).toBe(true);
    expect(hasRaster("a", true, 0)).toBe(false);
    let want = true;
    requestRaster(req("x", { priority: 1, wanted: () => want }));
    expect(hasRaster("x", false, 1)).toBe(true);
    // A more urgent request would replace the queued one.
    expect(hasRaster("x", false, 0)).toBe(false);
    want = false;
    expect(hasRaster("x", false, 1)).toBe(false);
    expect(hasRaster("y", false, 1)).toBe(false);
  });

  it("tells listeners which queued jobs it dropped as unwanted", () => {
    const dropped: string[] = [];
    const off = subscribeRasterDropped((key) => {
      dropped.push(key);
    });
    for (const k of ["a", "b", "c", "d"]) {
      requestRaster(req(k));
    }
    let want = true;
    requestRaster(req("x", { wanted: () => want }));
    // Another layer would skip x: the queued job is still wanted.
    expect(hasRaster("x", false, 0)).toBe(true);
    want = false;
    const w = FakeRasterWorker.last!;
    w.reply({ type: "done", id: 1, bitmap: bitmap(), backend: "webgl2" });
    expect(dropped).toEqual(["x"]);
    expect(w.posted).toHaveLength(4);
    off();
  });
});
