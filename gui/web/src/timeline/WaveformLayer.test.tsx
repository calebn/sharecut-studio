import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { bitmapCache } from "../waveform/bitmapCache";
import type { RasterRequest } from "../waveform/rasterClient";
import type { MediaRef, ReadyEntry, StatusEntry } from "../waveform/types";
import { clearWaveformFillCache } from "./waveformTheme";

const state = vi.hoisted(() => ({
  entries: {} as Record<string, unknown>,
  loaded: new Set<number>(),
  pcm: false,
  rasters: [] as unknown[],
  tileRequests: [] as { level: number; tiles: number[]; priority: number }[],
  pcmRequests: [] as number[][],
  listeners: new Set<() => void>(),
}));

/** Set a status entry the way a poll would, notifying subscribers. */
function setEntry(ref: string, entry: unknown) {
  act(() => {
    state.entries[ref] = entry;
    for (const fn of state.listeners) {
      fn();
    }
  });
}

vi.mock("../waveform/statusStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useWaveformStatus: (_p: string, _k: string, ref: string) =>
      useSyncExternalStore(
        (fn: () => void) => {
          state.listeners.add(fn);
          return () => state.listeners.delete(fn);
        },
        () => state.entries[ref] ?? null,
      ),
  };
});
vi.mock("../waveform/pyramidStore", () => ({
  PRIORITY_VISIBLE: 0,
  PRIORITY_OVERSCAN: 1,
  requestTiles: (
    _s: unknown,
    level: number,
    tiles: number[],
    priority: number,
  ) => state.tileRequests.push({ level, tiles: [...tiles], priority }),
  hasBins: (_m: unknown, level: number) => state.loaded.has(level),
  getBins: (_m: unknown, _l: number, _b: number, count: number) =>
    new Int16Array(count * 3).fill(1000),
  subscribePyramid: () => () => {},
}));
vi.mock("../waveform/pcmStore", () => ({
  requestPcm: (_s: unknown, b0: number, b1: number) =>
    state.pcmRequests.push([b0, b1]),
  getPcm: (_k: string, frameStart: number) =>
    state.pcm
      ? { pcm: new Int16Array(8), pcmStart: Math.floor(frameStart) }
      : null,
  subscribePcm: () => () => {},
}));
vi.mock("../waveform/rasterClient", () => ({
  requestRaster: (req: unknown) => state.rasters.push(req),
  subscribeRasterDone: () => () => {},
}));

const { WaveformLayer } = await import("./WaveformLayer");

const MEDIA_HASH = "a1".repeat(10);

/** 60 s of 48 kHz media: levels of 64·4^ℓ frames per bin. */
function ready(key = MEDIA_HASH): ReadyEntry {
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
  };
}

/** A ResizeObserver that reports at once, like a first layout. */
class InstantResizeObserver {
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
const CLIP_FILL = "rgb(13, 126, 117)";

const drawImage = vi.fn();
const baseProps = {
  mediaRef: "track:host" as MediaRef,
  kind: "raw" as const,
  mediaStartSec: 0,
  clipLeftCss: 0,
  clipWidthCss: 2000,
  zoom: 100,
  colorVar: "var(--clip-dialogue-0)",
};

function mount(props: Partial<typeof baseProps> = {}) {
  const onRender = vi.fn();
  const tree = (p: Partial<typeof baseProps>) => (
    <div className="clip-block" style={{ background: CLIP_FILL }}>
      <Profiler id="layer" onRender={onRender}>
        <WaveformLayer {...baseProps} {...p} />
      </Profiler>
    </div>
  );
  const view = render(tree(props));
  const update = (p: Partial<typeof baseProps>) => view.rerender(tree(p));
  const tiles = () => [
    ...view.container.querySelectorAll<HTMLCanvasElement>(
      "canvas.clip-waveform-tile",
    ),
  ];
  return { ...view, tiles, onRender, update };
}

const rasters = () => state.rasters as RasterRequest[];

describe("WaveformLayer", () => {
  beforeEach(() => {
    state.entries = { "track:host": ready() };
    state.loaded = new Set([0, 1, 2, 3, 4, 5]);
    state.pcm = false;
    state.rasters = [];
    state.tileRequests = [];
    state.pcmRequests = [];
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
    useDawStore.setState({
      projectPath: "/tmp/p.json",
      scrollLeft: 0,
      timelineViewportWidth: 800,
      waveformAmpZoom: 1,
    });
  });

  afterEach(() => {
    bitmapCache.clear();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("draws nothing under the minimum clip width", () => {
    const { container } = mount({ clipWidthCss: 5 });
    expect(container.querySelector(".clip-waveform")).toBeNull();
  });

  it("mounts the visible tiles (plus overscan) and rasterizes them from bins", () => {
    const { tiles } = mount();
    // View 0..800 plus 512 overscan: tiles 0..2 (1536 px).
    expect(tiles().map((c) => c.style.left)).toEqual([
      "0px",
      "512px",
      "1024px",
    ]);
    expect(tiles()[0]!.width).toBe(512);
    expect(tiles()[0]!.height).toBe(50);
    const first = rasters()[0]!;
    // 100 px/s at dpr 1: 480 frames per column, level 1 (256) draws it.
    expect(first.job).toMatchObject({
      cols: 512,
      rows: 50,
      mode: "pyramid",
      frameStart: 0,
      sppDev: 480,
      ampZoom: 1,
    });
    expect(first.job.source).toMatchObject({ kind: "pyramid", spp: 256 });
    expect(first.provisional).toBe(false);
    expect(first.wanted()).toBe(true);
    expect(rasters().map((r) => [r.tile, r.priority])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
    expect(state.tileRequests[0]).toMatchObject({ level: 1, tiles: [0] });
  });

  it("draws a cached bitmap instead of rasterizing again", () => {
    mount();
    const req = rasters()[0]!;
    bitmapCache.set(req.key, {
      bitmap: { close: vi.fn() } as unknown as ImageBitmap,
      width: 512,
      height: 50,
      group: req.group,
      zoom: req.zoom,
      tile: req.tile,
      provisional: false,
    });
    state.rasters = [];
    const again = mount();
    expect(drawImage).toHaveBeenCalled();
    expect(rasters().map((r) => r.tile)).not.toContain(0);
    again.unmount();
  });

  it("renders a provisional tile from a coarser level while bins load", () => {
    state.loaded = new Set([3]);
    mount();
    const first = rasters()[0]!;
    expect(first.provisional).toBe(true);
    expect(first.job.source).toMatchObject({ kind: "pyramid", spp: 4096 });
  });

  it("switches to host PCM below level 0, never for guests", () => {
    // 1000 px/s: 48 frames per column.
    mount({ zoom: 1000 });
    expect(state.pcmRequests[0]).toEqual([0, 0]);
    state.pcm = true;
    state.rasters = [];
    mount({ zoom: 1000 });
    expect(rasters()[0]!.job.mode).toBe("pcm");
    state.rasters = [];
    state.pcmRequests = [];
    useDawStore.setState({ projectPath: "share:tok" });
    mount({ zoom: 1000 });
    expect(state.pcmRequests).toEqual([]);
    expect(rasters()[0]!.job.mode).toBe("pyramid");
  });

  it("re-renders on scroll only when its tile range changes", () => {
    const { onRender, tiles } = mount();
    onRender.mockClear();
    act(() => useDawStore.setState({ scrollLeft: 100 }));
    act(() => useDawStore.setState({ scrollLeft: 200 }));
    expect(onRender).not.toHaveBeenCalled();
    act(() => useDawStore.setState({ scrollLeft: 1500 }));
    expect(onRender).toHaveBeenCalled();
    expect(tiles().map((c) => c.style.left)).toEqual([
      "512px",
      "1024px",
      "1536px",
    ]);
  });

  it("keeps the old pyramid until the new ref is ready, hides on unavailable", () => {
    const view = mount();
    setEntry("source:s1", { status: "generating" } satisfies StatusEntry);
    view.update({ mediaRef: "source:s1" });
    expect(view.tiles()).toHaveLength(3);
    setEntry("source:s1", {
      status: "unavailable",
      reason: "no-media",
    } satisfies StatusEntry);
    expect(view.tiles()).toHaveLength(0);
    setEntry("source:s1", ready("b2".repeat(10)));
    expect(view.tiles()).toHaveLength(3);
  });

  it("anchors tiles to the media, so a trim only moves them", () => {
    // Media starts 1.5 s (150 px) in: tile edges land at k·512 − 150.
    const { tiles } = mount({ mediaStartSec: 1.5 });
    expect(tiles()[0]!.style.left).toBe("0px");
    expect(tiles()[1]!.style.left).toBe("362px");
    expect(rasters()[0]!.tile).toBe(0);
  });

  it("washes quiet stretches from pyramid data at detail zoom", () => {
    // All bins are 1000/32767 ≈ 0.03: quiet everywhere.
    const { container } = mount({ zoom: 100 });
    const bands = container.querySelectorAll(".clip-waveform-quiet");
    expect(bands.length).toBe(1);
    const coarse = mount({ zoom: 4 });
    expect(
      coarse.container.querySelectorAll(".clip-waveform-quiet"),
    ).toHaveLength(0);
  });
});
