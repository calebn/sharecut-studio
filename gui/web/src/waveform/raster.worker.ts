import { GlRaster } from "./rasterGl";
import {
  handleRasterMessage,
  type RasterEngine,
  type RasterInMsg,
  type RasterOutMsg,
  readyMessage,
} from "./rasterProtocol";

/**
 * Raster worker entry: WebGL2 on an `OffscreenCanvas` when available,
 * otherwise the CPU rasterizer plus `createImageBitmap(ImageData)`.
 */

export type RasterScope = {
  postMessage(msg: RasterOutMsg, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<RasterInMsg>) => void) | null;
};

export function createRasterEngine(): RasterEngine {
  const canvas =
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1);
  const gl = canvas ? GlRaster.create(canvas) : null;
  return {
    gl,
    glBitmap: () => {
      if (!canvas) {
        throw new Error("no OffscreenCanvas");
      }
      return canvas.transferToImageBitmap();
    },
    cpuBitmap: (px, cols, rows) =>
      createImageBitmap(new ImageData(px, cols, rows)),
  };
}

export function startRasterWorker(
  scope: RasterScope,
  engine: RasterEngine = createRasterEngine(),
): void {
  scope.postMessage(readyMessage(engine));
  scope.onmessage = (ev) => {
    void handleRasterMessage(ev.data, engine).then((out) => {
      scope.postMessage(out, out.type === "done" ? [out.bitmap] : []);
    });
  };
}

// Started only inside a real worker; tests call startRasterWorker().
if (
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
  "undefined"
) {
  startRasterWorker(globalThis as unknown as RasterScope);
}
