import { describe, expect, it, vi } from "vitest";
import { rasterCpu } from "./rasterCpu";
import {
  engineBackend,
  handleRasterMessage,
  parityJob,
  type RasterEngine,
  rasterParityValue,
  readyMessage,
} from "./rasterProtocol";
import { jobGeometry } from "./shade";

const bitmap = {} as ImageBitmap;

/** A GL stand-in whose pixels are the CPU raster, premultiplied. */
function mirrorGl(offset = 0) {
  let last = new Uint8Array(0);
  return {
    lost: false,
    render: vi.fn(
      (
        geom: Float32Array,
        cols: number,
        rows: number,
        core: Float32Array,
        edge: Float32Array,
      ) => {
        const px = rasterCpu(geom, cols, rows, core, edge);
        last = new Uint8Array(px.length);
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3]!;
          for (let k = 0; k < 3; k++) {
            last[i + k] = Math.round((px[i + k]! * a) / 255);
          }
          last[i + 3] = Math.min(255, a + (a > 0 ? offset : 0));
        }
      },
    ),
    readTopDown: vi.fn(() => last),
  };
}

const cpuBitmaps = new Map<RasterEngine, ReturnType<typeof vi.fn>>();

function engine(gl: RasterEngine["gl"]): RasterEngine {
  const cpuBitmap = vi.fn(async () => bitmap);
  const e: RasterEngine = { gl, glBitmap: () => bitmap, cpuBitmap };
  cpuBitmaps.set(e, cpuBitmap);
  return e;
}

describe("rasterParityValue", () => {
  it("compares premultiplied GL with straight CPU pixels", () => {
    const cpu = new Uint8ClampedArray([200, 100, 50, 128]);
    const exact = new Uint8Array([100, 50, 25, 128]);
    expect(rasterParityValue(exact, cpu)).toBeLessThanOrEqual(0.5 / 255);
    const off = new Uint8Array([100, 50, 25, 131]);
    expect(rasterParityValue(off, cpu)).toBeCloseTo(3 / 255, 6);
  });
});

describe("handleRasterMessage", () => {
  it("announces the backend it will use", () => {
    expect(readyMessage(engine(null))).toEqual({
      type: "ready",
      backend: "cpu-worker",
    });
    const gl = mirrorGl();
    expect(engineBackend(engine(gl))).toBe("webgl2");
    expect(engineBackend(engine({ ...gl, lost: true }))).toBe("cpu-worker");
  });

  it("renders through GL when it is live", async () => {
    const gl = mirrorGl();
    const e = engine(gl);
    const job = parityJob();
    const out = await handleRasterMessage({ type: "render", id: 3, job }, e);
    expect(out).toEqual({ type: "done", id: 3, bitmap, backend: "webgl2" });
    expect(gl.render).toHaveBeenCalledWith(
      jobGeometry(job),
      job.cols,
      job.rows,
      job.core,
      job.edge,
    );
    expect(cpuBitmaps.get(e)).not.toHaveBeenCalled();
  });

  it("falls back to the CPU after a context loss", async () => {
    const e = engine({ ...mirrorGl(), lost: true });
    const job = parityJob();
    const out = await handleRasterMessage({ type: "render", id: 4, job }, e);
    expect(out).toEqual({ type: "done", id: 4, bitmap, backend: "cpu-worker" });
    expect(cpuBitmaps.get(e)).toHaveBeenCalledWith(
      rasterCpu(jobGeometry(job), job.cols, job.rows, job.core, job.edge),
      job.cols,
      job.rows,
    );
  });

  it("reports errors with the job id", async () => {
    const job = { ...parityJob(), rows: 0 };
    const out = await handleRasterMessage(
      { type: "render", id: 5, job },
      engine(null),
    );
    expect(out).toMatchObject({ type: "error", id: 5 });
    const failing = engine(null);
    failing.cpuBitmap = () => Promise.reject(new Error("no bitmap"));
    expect(
      await handleRasterMessage(
        { type: "render", id: 6, job: parityJob() },
        failing,
      ),
    ).toEqual({ type: "error", id: 6, message: "no bitmap" });
  });

  it("measures GL vs CPU parity, or null without GL", async () => {
    expect(
      await handleRasterMessage({ type: "parity", id: 1 }, engine(null)),
    ).toEqual({ type: "parity", id: 1, value: null });
    const same = await handleRasterMessage(
      { type: "parity", id: 2 },
      engine(mirrorGl()),
    );
    expect(same.type === "parity" && same.value).toBeLessThanOrEqual(1 / 255);
    const drift = await handleRasterMessage(
      { type: "parity", id: 3 },
      engine(mirrorGl(4)),
    );
    expect(drift.type === "parity" && drift.value).toBeGreaterThan(3 / 255);
  });
});
