import { errorMessage } from "../utils/apiError";
import { rasterCpu } from "./rasterCpu";
import type { GlRaster } from "./rasterGl";
import { jobGeometry } from "./shade";
import type { RasterJob } from "./types";

/** Messages between `rasterClient` and `raster.worker` (pure handler). */

export type WorkerBackend = "webgl2" | "cpu-worker";

export type RasterRenderMsg = { type: "render"; id: number; job: RasterJob };
export type RasterParityMsg = { type: "parity"; id: number };
export type RasterInMsg = RasterRenderMsg | RasterParityMsg;

export type RasterReadyMsg = { type: "ready"; backend: WorkerBackend };
/** A finished tile as a bitmap: the worker's GL canvas, or a CPU tile the page built. */
export type RasterDoneMsg = {
  type: "done";
  id: number;
  bitmap: ImageBitmap;
  backend: WorkerBackend;
};
/**
 * A finished CPU tile: straight-alpha RGBA, transferred. The page builds the
 * bitmap, because WPE WebKit crashes its web process when a worker makes
 * ImageBitmaps (#1110).
 */
export type RasterPixelsMsg = {
  type: "done";
  id: number;
  backend: "cpu-worker";
  pixels: Uint8ClampedArray<ArrayBuffer>;
  cols: number;
  rows: number;
};
export type RasterErrorMsg = { type: "error"; id: number; message: string };
export type RasterParityResultMsg = {
  type: "parity";
  id: number;
  /** Largest GL vs CPU difference (0..1), or null without WebGL2. */
  value: number | null;
};
/** What the page handles once a CPU tile has its bitmap. */
export type RasterReply =
  | RasterReadyMsg
  | RasterDoneMsg
  | RasterErrorMsg
  | RasterParityResultMsg;
/** What the worker posts. */
export type RasterOutMsg = RasterReply | RasterPixelsMsg;

/** What the worker renders with. `gl` is null without WebGL2. */
export type RasterEngine = {
  gl: Pick<GlRaster, "lost" | "render" | "readTopDown"> | null;
  /** The GL canvas as an upright bitmap (`transferToImageBitmap`). */
  glBitmap(): ImageBitmap;
};

function liveGl(engine: RasterEngine) {
  return engine.gl && !engine.gl.lost ? engine.gl : null;
}

export function engineBackend(engine: RasterEngine): WorkerBackend {
  return liveGl(engine) ? "webgl2" : "cpu-worker";
}

export function readyMessage(engine: RasterEngine): RasterReadyMsg {
  return { type: "ready", backend: engineBackend(engine) };
}

/** The fixed tile `rasterParity()` renders through both backends. */
export function parityJob(): RasterJob {
  const cols = 96;
  const bins = new Int16Array(cols * 3);
  for (let c = 0; c < cols; c++) {
    const amp = Math.abs(Math.sin(c / 7)) * (0.3 + 0.7 * ((c % 11) / 10));
    bins[c * 3] = Math.round(-amp * 32767 * (0.6 + 0.4 * Math.cos(c / 3)));
    bins[c * 3 + 1] = Math.round(amp * 32767);
    bins[c * 3 + 2] = Math.round(amp * 0.45 * 32767);
  }
  return {
    cols,
    rows: 57,
    mode: "pyramid",
    frameStart: 0,
    sppDev: 64,
    ampZoom: 1.25,
    scale: "linear",
    core: new Float32Array([0.48, 0.72, 0.7, 1]),
    edge: new Float32Array([0.73, 0.86, 0.85, 0.6]),
    source: { kind: "pyramid", bins, binStart: 0, spp: 64 },
  };
}

/**
 * Largest per-pixel difference between GL output (premultiplied, top row
 * first) and CPU output (straight alpha): `max(|Δa|, |Δ(rgb·a)| / 255)`.
 */
export function rasterParityValue(
  glPremultiplied: Uint8Array,
  cpuStraight: Uint8ClampedArray,
): number {
  let worst = 0;
  for (let i = 0; i < cpuStraight.length; i += 4) {
    const aCpu = cpuStraight[i + 3]!;
    worst = Math.max(worst, Math.abs(glPremultiplied[i + 3]! - aCpu) / 255);
    for (let k = 0; k < 3; k++) {
      const cpu = (cpuStraight[i + k]! * aCpu) / 255;
      worst = Math.max(worst, Math.abs(glPremultiplied[i + k]! - cpu) / 255);
    }
  }
  return worst;
}

/** The buffers a worker reply hands over instead of copying. */
export function replyTransfer(out: RasterOutMsg): Transferable[] {
  if (out.type !== "done") {
    return [];
  }
  return "pixels" in out ? [out.pixels.buffer] : [out.bitmap];
}

/** Handle one message in the worker. */
export function handleRasterMessage(
  msg: RasterInMsg,
  engine: RasterEngine,
): RasterOutMsg {
  try {
    if (msg.type === "parity") {
      const gl = liveGl(engine);
      if (!gl) {
        return { type: "parity", id: msg.id, value: null };
      }
      const job = parityJob();
      const geom = jobGeometry(job);
      gl.render(geom, job.cols, job.rows, job.core, job.edge);
      const glPx = gl.readTopDown(job.cols, job.rows);
      const cpuPx = rasterCpu(geom, job.cols, job.rows, job.core, job.edge);
      return {
        type: "parity",
        id: msg.id,
        value: rasterParityValue(glPx, cpuPx),
      };
    }
    const { job } = msg;
    if (job.cols < 1 || job.rows < 1) {
      throw new Error(`empty raster ${job.cols}×${job.rows}`);
    }
    const geom = jobGeometry(job);
    const gl = liveGl(engine);
    if (gl) {
      gl.render(geom, job.cols, job.rows, job.core, job.edge);
      return {
        type: "done",
        id: msg.id,
        bitmap: engine.glBitmap(),
        backend: "webgl2",
      };
    }
    return {
      type: "done",
      id: msg.id,
      backend: "cpu-worker",
      pixels: rasterCpu(geom, job.cols, job.rows, job.core, job.edge),
      cols: job.cols,
      rows: job.rows,
    };
  } catch (err) {
    return { type: "error", id: msg.id, message: errorMessage(err) };
  }
}
