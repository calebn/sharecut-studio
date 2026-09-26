import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  CLIP_FILL,
  doneMsg,
  FakeRasterWorker,
  rasterRequest,
  restoreWaveformLayerDom,
  stubRasterWorker,
  stubWaveformLayerDom,
  WAVEFORM_LAYER_PROPS,
} from "../test/waveform";
import { bitmapCache } from "../waveform/bitmapCache";
import type { RasterRequest } from "../waveform/rasterClient";

const calls = vi.hoisted(() => ({ requests: [] as RasterRequest[] }));

vi.mock("../waveform/statusStore", async () => {
  const { readyEntry } = await import("../test/waveform");
  const entry = readyEntry();
  return { useWaveformStatus: () => entry };
});
vi.mock("../waveform/pyramidStore", () => ({
  PRIORITY_VISIBLE: 0,
  PRIORITY_OVERSCAN: 1,
  requestTiles: () => {},
  hasBins: () => true,
  getBins: (_m: unknown, _l: number, _b: number, count: number) =>
    new Int16Array(count * 3).fill(1000),
  subscribePyramid: () => () => {},
}));
vi.mock("../waveform/pcmStore", () => ({
  requestPcm: () => {},
  getPcm: () => null,
  subscribePcm: () => () => {},
}));
vi.mock("../waveform/rasterClient", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../waveform/rasterClient")>();
  return {
    ...mod,
    requestRaster: (req: RasterRequest) => {
      calls.requests.push(req);
      mod.requestRaster(req);
    },
  };
});

const { WaveformLayer } = await import("./WaveformLayer");
const { resetRasterClient, requestRaster } = await import(
  "../waveform/rasterClient"
);

function mountLayer() {
  return render(
    <div className="clip-block" style={{ background: CLIP_FILL }}>
      <WaveformLayer {...WAVEFORM_LAYER_PROPS} clipWidthCss={400} />
    </div>,
  );
}

const tileRequests = () =>
  calls.requests.filter((r) => !r.key.startsWith("blocker-"));

describe("WaveformLayer with the real raster client", () => {
  beforeEach(() => {
    calls.requests = [];
    stubRasterWorker();
    stubWaveformLayerDom(vi.fn());
    useDawStore.setState({
      projectPath: "/tmp/p.json",
      scrollLeft: 0,
      timelineViewportWidth: 800,
      waveformAmpZoom: 1,
    });
  });

  afterEach(() => {
    resetRasterClient();
    bitmapCache.clear();
    restoreWaveformLayerDom();
  });

  it("re-requests a shared tile exactly once when the queued job it deferred to is dropped", () => {
    for (let i = 0; i < 4; i++) {
      requestRaster(rasterRequest(`blocker-${i}`));
    }
    const w = FakeRasterWorker.last!;
    const a = mountLayer();
    const b = mountLayer();
    // A asked; B skipped through `hasRaster`.
    expect(tileRequests()).toHaveLength(1);
    expect(w.posted).toHaveLength(4);
    const key = tileRequests()[0]!.key;

    a.unmount();
    act(() => w.reply(doneMsg(1)));
    // A's queued job is dropped; B asks once.
    expect(tileRequests()).toHaveLength(2);
    expect(tileRequests()[1]!.key).toBe(key);
    expect(w.posted).toHaveLength(5);

    for (const id of [2, 3, 4]) {
      act(() => w.reply(doneMsg(id)));
    }
    expect(tileRequests()).toHaveLength(2);
    act(() => w.reply(doneMsg(5)));
    expect(bitmapCache.get(key)).toBeDefined();

    b.unmount();
    const n = calls.requests.length;
    for (let i = 0; i < 4; i++) {
      requestRaster(rasterRequest(`blocker-${6 + i}`));
    }
    requestRaster(rasterRequest(key, { wanted: () => false }));
    act(() => w.reply(doneMsg(6)));
    act(() => w.onerror?.());
    // Only the test's own direct requests: nothing fires after both unmount.
    expect(calls.requests.length).toBe(n + 5);
  });

  it("re-requests a tile whose job died with a crashed worker, on the restarted worker", () => {
    const view = mountLayer();
    const w = FakeRasterWorker.last!;
    expect(w.posted).toHaveLength(1);
    act(() => w.onerror?.());
    const next = FakeRasterWorker.last!;
    expect(next).not.toBe(w);
    expect(tileRequests()).toHaveLength(2);
    expect(tileRequests()[1]!.key).toBe(tileRequests()[0]!.key);
    expect(next.posted).toHaveLength(1);

    view.unmount();
    act(() => next.onerror?.());
    expect(tileRequests()).toHaveLength(2);
  });
});
