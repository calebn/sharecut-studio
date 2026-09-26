import { vi } from "vitest";
import { clearWaveformFillCache } from "../timeline/waveformTheme";
import type { RasterRequest } from "../waveform/rasterClient";
import {
  parityJob,
  type RasterInMsg,
  type RasterOutMsg,
} from "../waveform/rasterProtocol";
import type { MediaRef, ReadyEntry } from "../waveform/types";

/** A stand-in raster `Worker` that records what it is sent. */
export class FakeRasterWorker {
  static last: FakeRasterWorker | null = null;
  static created = 0;
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
    FakeRasterWorker.last = this;
    FakeRasterWorker.created += 1;
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

export function stubRasterWorker(): void {
  vi.stubGlobal("Worker", FakeRasterWorker);
  vi.stubGlobal("createImageBitmap", vi.fn());
  FakeRasterWorker.last = null;
  FakeRasterWorker.created = 0;
}

export function rasterRequest(
  key: string,
  over: Partial<RasterRequest> = {},
): RasterRequest {
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

export function fakeBitmap(close = vi.fn()): ImageBitmap {
  return { close } as unknown as ImageBitmap;
}

export function doneMsg(
  id: number,
  bitmap: ImageBitmap = fakeBitmap(),
): RasterOutMsg {
  return { type: "done", id, bitmap, backend: "webgl2" };
}

export const MEDIA_HASH = "a1".repeat(10);

/** 60 s of 48 kHz media: levels of 64·4^ℓ frames per bin; `over` replaces fields. */
export function readyEntry(
  key = MEDIA_HASH,
  over: Partial<ReadyEntry> = {},
): ReadyEntry {
  const total = 48000 * 60;
  const levels = [0, 1, 2, 3, 4, 5].map((l) => {
    const spp = 64 * 4 ** l;
    return { spp, bins: Math.ceil(total / spp) };
  });
  return {
    status: "ready",
    key,
    sample_rate: 48000,
    channels: 1,
    total_frames: total,
    base_spp: 64,
    level_factor: 4,
    bins_per_tile: 4096,
    levels,
    ...over,
  };
}

/** A ResizeObserver that reports at once, like a first layout. */
export class InstantResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    this.cb(
      [{ target: el } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

/** A computed lane fill, as `getComputedStyle` reports it. */
export const CLIP_FILL = "rgb(13, 126, 117)";

export const WAVEFORM_LAYER_PROPS = {
  mediaRef: "track:host" as MediaRef,
  kind: "raw" as const,
  mediaStartSec: 0,
  clipLeftCss: 0,
  clipWidthCss: 2000,
  zoom: 100,
  colorVar: "var(--clip-dialogue-0)",
};

/** The DOM stubs a `WaveformLayer` needs in jsdom. */
export function stubWaveformLayerDom(drawImage: ReturnType<typeof vi.fn>) {
  clearWaveformFillCache();
  vi.stubGlobal("ResizeObserver", InstantResizeObserver);
  vi.stubGlobal("devicePixelRatio", 1);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 50,
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: vi.fn(),
    drawImage,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  drawImage.mockClear();
}

export function restoreWaveformLayerDom(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
}
