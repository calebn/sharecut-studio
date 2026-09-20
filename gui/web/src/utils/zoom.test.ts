import { describe, expect, it } from "vitest";
import {
  anchoredZoomScroll,
  clampZoomPxPerSec,
  discreteZoomFactor,
  fitZoomPxPerSec,
  MAX_ZOOM_PX_PER_SEC,
  MIN_ZOOM_PX_PER_SEC,
  wheelZoomFactor,
  ZOOM_STEP,
} from "./zoom";

describe("fitZoomPxPerSec", () => {
  it("fits a short session above the old 2px/sec floor", () => {
    const z = fitZoomPxPerSec(900, 60);
    expect(z).toBeCloseTo(900 / 60, 5);
    expect(60 * z).toBeLessThanOrEqual(900);
  });

  it("fits a long session below 2px/sec so the full duration is in view", () => {
    const duration = 45 * 60;
    const viewport = 900;
    const z = fitZoomPxPerSec(viewport, duration);
    expect(z).toBeLessThan(2);
    expect(z).toBeGreaterThanOrEqual(MIN_ZOOM_PX_PER_SEC);
    expect(duration * z).toBeLessThanOrEqual(viewport);
  });

  it("clamps to MIN_ZOOM for extreme durations", () => {
    expect(fitZoomPxPerSec(800, 1_000_000)).toBe(MIN_ZOOM_PX_PER_SEC);
  });
});

describe("clampZoomPxPerSec / discrete steps", () => {
  it("clamps to min and max", () => {
    expect(clampZoomPxPerSec(0)).toBe(MIN_ZOOM_PX_PER_SEC);
    expect(clampZoomPxPerSec(9999)).toBe(MAX_ZOOM_PX_PER_SEC);
  });

  it("uses one step for keyboard and wheel ticks", () => {
    expect(discreteZoomFactor("in")).toBe(ZOOM_STEP);
    expect(discreteZoomFactor("out")).toBe(1 / ZOOM_STEP);
    expect(wheelZoomFactor(-1)).toBe(ZOOM_STEP);
    expect(wheelZoomFactor(1)).toBe(1 / ZOOM_STEP);
  });
});

describe("anchoredZoomScroll", () => {
  it("keeps the time under clientX stable when zooming in", () => {
    const currentZoom = 40;
    const clientX = 100;
    const rectLeft = 0;
    const scrollLeft = 200;
    const anchorSec = (clientX - rectLeft + scrollLeft) / currentZoom;
    const { zoom, scrollLeft: nextScroll } = anchoredZoomScroll({
      currentZoom,
      nextZoom: currentZoom * ZOOM_STEP,
      clientX,
      rectLeft,
      scrollLeft,
    });
    expect(zoom).toBe(currentZoom * ZOOM_STEP);
    expect((clientX - rectLeft + nextScroll) / zoom).toBeCloseTo(anchorSec, 8);
  });
});
