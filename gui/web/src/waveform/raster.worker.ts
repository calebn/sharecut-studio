import { GlRaster } from "./rasterGl";
import {
  handleRasterMessage,
  type RasterEngine,
  type RasterInMsg,
  type RasterOutMsg,
  readyMessage,
  replyTransfer,
} from "./rasterProtocol";

/**
 * Raster worker entry: WebGL2 on an `OffscreenCanvas` when available,
 * otherwise the CPU rasterizer, whose pixels the page turns into a bitmap.
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
  };
}

export function startRasterWorker(
  scope: RasterScope,
  engine: RasterEngine = createRasterEngine(),
): void {
  scope.postMessage(readyMessage(engine));
  scope.onmessage = (ev) => {
    const out = handleRasterMessage(ev.data, engine);
    scope.postMessage(out, replyTransfer(out));
  };
}

// Started only inside a real worker; tests call startRasterWorker().
if (
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
  "undefined"
) {
  startRasterWorker(globalThis as unknown as RasterScope);
}
