import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bitmapCache } from "./bitmapCache";
import {
  getRasterBackend,
  type RasterRequest,
  rasterParity,
  rasterTilesRendered,
  requestRaster,
  resetRasterClient,
  startRasterWorker,
  subscribeRasterBackend,
  subscribeRasterDone,
} from "./rasterClient";
import { parityJob, type RasterInMsg } from "./rasterProtocol";

class FakeWorker {
  static last: FakeWorker | null = null;
  posted: { msg: RasterInMsg; transfer: Transferable[] }[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly url: URL;
  readonly opts: WorkerOptions;
  constructor(url: URL, opts: WorkerOptions) {
    this.url = url;
    this.opts = opts;
    FakeWorker.last = this;
  }
  postMessage(msg: RasterInMsg, transfer: Transferable[]) {
    this.posted.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

function req(key: string, over: Partial<RasterRequest> = {}): RasterRequest {
  return {
    key,
    job: parityJob(),
    group: "g",
    zoom: 100,
    tile: 0,
    provisional: false,
    priority: 0,
    wanted: () => true,
    ...over,
  };
}

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap;

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
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("createImageBitmap", vi.fn());
    FakeWorker.last = null;
  });

  afterEach(() => {
    resetRasterClient();
    bitmapCache.clear();
    vi.unstubAllGlobals();
  });

  it("frees the slot when postMessage throws", () => {
    startRasterWorker();
    const w = FakeWorker.last!;
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
    FakeWorker.last!.reply({
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
    FakeWorker.last!.reply({
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
    const w = FakeWorker.last!;
    w.reply({ type: "done", id: 1, bitmap: bitmap(), backend: "webgl2" });
    expect(w.posted).toHaveLength(5);
    w.reply({ type: "done", id: 5, bitmap: bitmap(), backend: "webgl2" });
    expect(bitmapCache.get("x")).toBeDefined();
  });

  it("starts a module worker lazily and takes its backend", () => {
    expect(getRasterBackend()).toBe("starting");
    expect(FakeWorker.last).toBeNull();
    const seen = vi.fn();
    const off = subscribeRasterBackend(seen);
    startRasterWorker();
    const w = FakeWorker.last!;
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
    const w = FakeWorker.last!;
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
  });

  it("caches results, stale ones too, and provisional ones as stand-ins", () => {
    const done = vi.fn();
    subscribeRasterDone(done);
    let wanted = true;
    requestRaster(req("x", { wanted: () => wanted, tile: 3, zoom: 50 }));
    requestRaster(req("y", { provisional: true }));
    wanted = false;
    const w = FakeWorker.last!;
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
    expect(FakeWorker.last!.posted).toHaveLength(1);
  });

  it("asks the worker for parity", async () => {
    const p = rasterParity();
    const w = FakeWorker.last!;
    const msg = w.posted[0]!.msg;
    expect(msg.type).toBe("parity");
    w.reply({ type: "parity", id: msg.id, value: 0.004 });
    await expect(p).resolves.toBe(0.004);
  });

  it("settles parity with null when posting to the worker throws", async () => {
    requestRaster(req("a"));
    const w = FakeWorker.last!;
    vi.spyOn(w, "postMessage").mockImplementation(() => {
      throw new Error("DataCloneError");
    });
    await expect(rasterParity()).resolves.toBeNull();
  });

  it("falls back to backend none when the worker fails", async () => {
    requestRaster(req("a"));
    const w = FakeWorker.last!;
    const parity = rasterParity();
    w.onerror?.();
    expect(w.terminated).toBe(true);
    expect(getRasterBackend()).toBe("none");
    await expect(parity).resolves.toBeNull();
    requestRaster(req("b"));
    expect(FakeWorker.last).toBe(w);
  });

  it("ignores errors but keeps pumping", () => {
    for (const k of ["a", "b", "c", "d", "e"]) {
      requestRaster(req(k));
    }
    const w = FakeWorker.last!;
    w.reply({ type: "error", id: 1, message: "boom" });
    expect(w.posted).toHaveLength(5);
    expect(rasterTilesRendered()).toBe(0);
  });
});
