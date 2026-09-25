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

  it("uses the CPU backend without OffscreenCanvas", async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmap = vi.fn(async () => bitmap);
    class FakeImageData {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    vi.stubGlobal("ImageData", FakeImageData);
    const engine = createRasterEngine();
    expect(engine.gl).toBeNull();
    expect(() => engine.glBitmap()).toThrow();
    const job = parityJob();
    await expect(
      engine.cpuBitmap(
        new Uint8ClampedArray(job.cols * job.rows * 4),
        job.cols,
        job.rows,
      ),
    ).resolves.toBe(bitmap);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(FakeImageData));
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
