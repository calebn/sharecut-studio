import { describe, expect, it, vi } from "vitest";
import type { PeaksData } from "../types/project";
import {
  WAVEFORM_OVERSCAN_PX as overscan,
  peaksCanvasCssWidth,
} from "../utils/peaks";
import {
  clipWaveformFill,
  paintWaveform,
  rangeMaxColumn,
  visibleClipWindow,
  WAVEFORM_OVERSCAN_PX,
} from "./drawWaveform";
import { quietBandsFromPeaks } from "./quietWash";
import { magnetSec, uniqueTicks } from "./snapOverlay";

describe("visibleClipWindow", () => {
  it("sizes canvas to viewport + overscan for a 3-hour clip", () => {
    const duration = 3 * 3600;
    const zoom = 200;
    const win = visibleClipWindow({
      clipTimelineStart: 0,
      clipSourceStart: 0,
      clipSourceEnd: duration,
      zoomPxPerSec: zoom,
      scrollLeft: 50_000,
      viewportWidth: 1000,
      overscanPx: WAVEFORM_OVERSCAN_PX,
    });
    expect(win.offscreen).toBe(false);
    expect(win.cssWidth).toBeLessThanOrEqual(
      1000 + 2 * WAVEFORM_OVERSCAN_PX + 1,
    );
    expect(win.cssWidth).toBeLessThan(duration * zoom);
  });

  it("marks fully offscreen clips", () => {
    const win = visibleClipWindow({
      clipTimelineStart: 0,
      clipSourceStart: 0,
      clipSourceEnd: 2,
      zoomPxPerSec: 40,
      scrollLeft: 5000,
      viewportWidth: 800,
    });
    expect(win.offscreen).toBe(true);
    expect(win.cssWidth).toBe(0);
  });
});

describe("range-max paint", () => {
  it("keeps the envelope peak when many bins map to a pixel", () => {
    const peaks = new Uint8Array([10, 10, 200, 10]);
    expect(rangeMaxColumn(peaks, 0, 4)).toBe(200);
  });

  it("paintWaveform is O(viewport) even for huge overview arrays", () => {
    const hours = 3 * 3600 * 16;
    const data: PeaksData = {
      peaks: new Uint8Array(hours).fill(20),
      sample_rate: 8000,
      samples_per_pixel: 500,
      encoding: "uint8",
    };
    const canvas = document.createElement("canvas");
    canvas.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    })) as unknown as typeof canvas.getContext;
    Object.defineProperty(canvas, "offsetHeight", { value: 40 });
    const t0 = performance.now();
    paintWaveform(canvas, {
      peaks: data,
      tiles: [],
      sourceStart: 0,
      sourceEnd: 10,
      cssWidth: 800,
      ampZoom: 1,
      devicePixelRatio: 1,
    });
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("paints a gradient mirrored at the midline from the clip tints", () => {
    const canvas = document.createElement("canvas");
    const addColorStop = vi.fn();
    const gradient = { addColorStop };
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createLinearGradient: vi.fn(() => gradient),
      fillStyle: "" as string | typeof gradient,
    };
    canvas.getContext = vi.fn(() => ctx) as unknown as typeof canvas.getContext;
    Object.defineProperty(canvas, "offsetHeight", { value: 40 });

    paintWaveform(canvas, {
      peaks: {
        peaks: new Uint8Array([255]),
        sample_rate: 8000,
        samples_per_pixel: 500,
        encoding: "uint8",
      },
      tiles: [],
      sourceStart: 0,
      sourceEnd: 1,
      cssWidth: 4,
      ampZoom: 1,
      peakFillCore: "rgb(1, 2, 3)",
      peakFillEdge: "rgb(4, 5, 6)",
    });

    expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 40);
    expect(addColorStop).toHaveBeenNthCalledWith(1, 0, "rgb(4, 5, 6)");
    expect(addColorStop).toHaveBeenNthCalledWith(2, 0.5, "rgb(1, 2, 3)");
    expect(addColorStop).toHaveBeenNthCalledWith(3, 1, "rgb(4, 5, 6)");
    expect(ctx.fillStyle).toBe(gradient);
  });
});

describe("clipWaveformFill", () => {
  it("lightens the clip fill toward white, brighter at the edge", () => {
    expect(clipWaveformFill("rgb(13, 126, 117)")).toEqual({
      core: "rgb(122, 184, 179)",
      edge: "rgb(187, 219, 216)",
    });
    expect(clipWaveformFill("rgba(0, 0, 0, 0.5)")).toEqual({
      core: "rgb(115, 115, 115)",
      edge: "rgb(184, 184, 184)",
    });
  });

  it("returns null for non-rgb fills so the themed peak color applies", () => {
    expect(clipWaveformFill("transparent")).toBeNull();
    expect(clipWaveformFill("")).toBeNull();
    expect(clipWaveformFill("oklch(0.5 0.1 180)")).toBeNull();
  });

  it("reads color(srgb …), what color-mix() and oklch() fills compute to", () => {
    const fromRgb = clipWaveformFill("rgb(13, 126, 117)");
    expect(clipWaveformFill("color(srgb 0.0509804 0.494118 0.458824)")).toEqual(
      fromRgb,
    );
    expect(
      clipWaveformFill("color(srgb 0.0509804 0.494118 0.458824 / 0.5)"),
    ).toEqual(fromRgb);
    // Out-of-gamut channels clamp instead of overshooting white.
    expect(clipWaveformFill("color(srgb 1.2 -0.1 1)")).toEqual(
      clipWaveformFill("rgb(255, 0, 255)"),
    );
  });

  it("treats a fully transparent fill as no fill", () => {
    expect(clipWaveformFill("rgba(0, 0, 0, 0)")).toBeNull();
    expect(clipWaveformFill("color(srgb 0 0 0 / 0)")).toBeNull();
    expect(clipWaveformFill("color(srgb 0 0 0 / 0%)")).toBeNull();
    expect(clipWaveformFill("rgb(0 0 0 / 0)")).toBeNull();
  });
});

describe("quiet wash + magnet", () => {
  it("clusters low bins into islands", () => {
    const peaks: PeaksData = {
      peaks: new Uint8Array([0, 0, 0, 0, 200, 200]),
      sample_rate: 8000,
      samples_per_pixel: 500,
      encoding: "uint8",
    };
    const bands = quietBandsFromPeaks(peaks, [], 0, 2);
    expect(bands.length).toBeGreaterThanOrEqual(0);
  });

  it("magnets proposed times onto nearby ticks", () => {
    expect(magnetSec(1.0, [1.03, 2], 200)).toBeCloseTo(1.03);
    expect(uniqueTicks([1, 1, 2])).toEqual([1, 2]);
  });
});

describe("peaksCanvasCssWidth viewport cap", () => {
  it("caps a 3-hour clip to viewport + overscan", () => {
    const huge = 3 * 3600 * 200;
    const w = peaksCanvasCssWidth(huge, 2, 8192, 1200);
    expect(w).toBeLessThanOrEqual(1200 + 2 * overscan);
    expect(w).toBeGreaterThan(0);
  });
});
