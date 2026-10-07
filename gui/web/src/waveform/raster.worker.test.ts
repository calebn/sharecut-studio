import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRasterEngine,
  type RasterScope,
  startRasterWorker,
} from "./raster.worker";
import { parityJob, type RasterEngine } from "./rasterProtocol";

describe("raster worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a CPU render with its pixels and never makes a bitmap", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const posted: [unknown, unknown][] = [];
    const scope: RasterScope = {
      postMessage: (msg, transfer) => posted.push([msg, transfer]),
      onmessage: null,
    };
    startRasterWorker(scope, createRasterEngine());
    const job = parityJob();
    scope.onmessage?.(
      new MessageEvent("message", { data: { type: "render", id: 1, job } }),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    const [msg, transfer] = posted[1] as [
      { pixels: Uint8ClampedArray },
      Transferable[],
    ];
    expect(msg).toEqual({
      type: "done",
      id: 1,
      backend: "cpu-worker",
      pixels: expect.any(Uint8ClampedArray),
      cols: job.cols,
      rows: job.rows,
    });
    expect(msg.pixels).toHaveLength(job.cols * job.rows * 4);
    expect(transfer).toEqual([msg.pixels.buffer]);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("announces readiness and answers with transferred bitmaps", async () => {
    const bitmap = {} as ImageBitmap;
    const engine: RasterEngine = {
      gl: null,
      glBitmap: () => bitmap,
      cpuBitmap: async () => bitmap,
    };
    const posted: [unknown, unknown][] = [];
    const scope: RasterScope = {
      postMessage: (msg, transfer) => posted.push([msg, transfer]),
      onmessage: null,
    };
    startRasterWorker(scope, engine);
    expect(posted[0]).toEqual([
      { type: "ready", backend: "cpu-worker" },
      undefined,
    ]);
    scope.onmessage?.(
      new MessageEvent("message", {
        data: { type: "render", id: 1, job: parityJob() },
      }),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual([
      { type: "done", id: 1, bitmap, backend: "cpu-worker" },
      [bitmap],
    ]);
    scope.onmessage?.(
      new MessageEvent("message", { data: { type: "parity", id: 2 } }),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toEqual([{ type: "parity", id: 2, value: null }, []]);
  });
});
