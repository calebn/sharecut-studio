import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  CLIP_FILL,
  readyEntry as ready,
  restoreWaveformLayerDom,
  stubWaveformLayerDom,
  WAVEFORM_LAYER_PROPS,
} from "../test/waveform";
import { bitmapCache } from "../waveform/bitmapCache";
import type { RasterRequest } from "../waveform/rasterClient";
import type { StatusEntry } from "../waveform/types";

const state = vi.hoisted(() => ({
  entries: {} as Record<string, unknown>,
  loaded: new Set<number>(),
  pcm: false,
  rasters: [] as unknown[],
  tileRequests: [] as {
    ref: string;
    level: number;
    tiles: number[];
    priority: number;
  }[],
  pcmRequests: [] as number[][],
  listeners: new Set<() => void>(),
  dropped: new Set<(key: string) => void>(),
  failed: new Set<(key: string) => void>(),
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
    s: { ref: string },
    level: number,
    tiles: number[],
    priority: number,
  ) =>
    state.tileRequests.push({ ref: s.ref, level, tiles: [...tiles], priority }),
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
  subscribeRasterDropped: (fn: (key: string) => void) => {
    state.dropped.add(fn);
    return () => state.dropped.delete(fn);
  },
  subscribeRasterFailed: (fn: (key: string) => void) => {
    state.failed.add(fn);
    return () => state.failed.delete(fn);
  },
  hasRaster: (key: string, provisional: boolean) =>
    (state.rasters as { key: string; provisional: boolean }[]).some(
      (r) => r.key === key && r.provisional === provisional,
    ),
}));
const quiet = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./quietWash", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./quietWash")>();
  return {
    ...mod,
    pyramidColumnPeaks: (
      ...args: Parameters<typeof mod.pyramidColumnPeaks>
    ) => {
      quiet.calls += 1;
      return mod.pyramidColumnPeaks(...args);
    },
  };
});

const { WaveformLayer } = await import("./WaveformLayer");

const drawImage = vi.fn();
const baseProps = WAVEFORM_LAYER_PROPS;

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
    stubWaveformLayerDom(drawImage);
    useDawStore.setState({
      projectPath: "/tmp/p.json",
      scrollLeft: 0,
      timelineViewportWidth: 800,
      waveformAmpZoom: 1,
    });
  });

  afterEach(() => {
    bitmapCache.clear();
    restoreWaveformLayerDom();
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

  it("does not rebuild a tile's job while its render is queued or in flight", () => {
    mount();
    const sent = rasters().length;
    const asked = state.tileRequests.length;
    // Same key, new object: the layer re-renders and its layout effect runs.
    setEntry("track:host", ready());
    expect(rasters()).toHaveLength(sent);
    expect(state.tileRequests).toHaveLength(asked);
  });

  it.each(["dropped", "failed"] as const)(
    "asks again for a wanted tile the client reports %s",
    (which) => {
      mount();
      const key = rasters()[0]!.key;
      state.rasters = rasters().filter((r) => r.key !== key);
      const before = rasters().length;
      act(() => {
        for (const fn of state[which]) {
          fn("not-a-tile-of-this-layer");
        }
      });
      expect(rasters()).toHaveLength(before);
      act(() => {
        for (const fn of state[which]) {
          fn(key);
        }
      });
      expect(rasters().filter((r) => r.key === key)).toHaveLength(1);
    },
  );

  it("asks for a held pyramid under its own ref, and drops it on a project change", () => {
    const view = mount();
    setEntry("source:s1", { status: "generating" } satisfies StatusEntry);
    state.rasters = [];
    state.tileRequests = [];
    view.update({ mediaRef: "source:s1" });
    expect(view.tiles()).toHaveLength(3);
    expect(state.tileRequests.length).toBeGreaterThan(0);
    expect(new Set(state.tileRequests.map((r) => r.ref))).toEqual(
      new Set(["track:host"]),
    );
    act(() => useDawStore.setState({ projectPath: "/tmp/q.json" }));
    expect(view.tiles()).toHaveLength(0);
  });

  it("reuses the quiet wash when a render changes no pyramid data", () => {
    const { onRender } = mount({ zoom: 100 });
    const before = quiet.calls;
    onRender.mockClear();
    act(() => useDawStore.setState({ waveformAmpZoom: 2 }));
    expect(onRender).toHaveBeenCalled();
    expect(quiet.calls).toBe(before);
  });
});
