import { describe, expect, it } from "vitest";
import { MAX_CONTENT_PX } from "./timelineZoom.generated";
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

  it("never fits above the session's ceiling", () => {
    // A 0.01 s session in 800 px would be 80,000 px/s.
    expect(fitZoomPxPerSec(800, 0.01)).toBe(MAX_ZOOM_PX_PER_SEC);
  });
});

describe("clampZoomPxPerSec / discrete steps", () => {
  it("clamps to min and to the session-aware max", () => {
    expect(clampZoomPxPerSec(0, 60)).toBe(MIN_ZOOM_PX_PER_SEC);
    expect(MAX_ZOOM_PX_PER_SEC).toBe(48000);
    expect(clampZoomPxPerSec(1e9, 60)).toBe(48000);
    // An hour: 15M px of content caps zoom at ~4167 px/s.
    expect(clampZoomPxPerSec(1e9, 3600)).toBeCloseTo(MAX_CONTENT_PX / 3600, 6);
    expect(clampZoomPxPerSec(9999, 60)).toBe(9999);
  });

  it.each([1, 60, 312, 1200, 3600, 36000])(
    "keeps a %s s session's content under MAX_CONTENT_PX",
    (sec) => {
      expect(sec * clampZoomPxPerSec(1e12, sec)).toBeLessThanOrEqual(
        MAX_CONTENT_PX + 1e-6,
      );
    },
  );

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
      sessionSec: 60,
    });
    expect(zoom).toBe(currentZoom * ZOOM_STEP);
    expect((clientX - rectLeft + nextScroll) / zoom).toBeCloseTo(anchorSec, 8);
  });

  it("clamps at 0 by default and at a lower bound when the view is padded", () => {
    const input = {
      currentZoom: 10,
      nextZoom: 20,
      clientX: 150,
      rectLeft: 0,
      scrollLeft: -100,
      sessionSec: 60,
    };
    // Anchor at 5 s: 5 s × 20 px/s − 150 px = −50 px.
    expect(anchoredZoomScroll(input).scrollLeft).toBe(0);
    expect(
      anchoredZoomScroll({ ...input, minScrollLeft: -187.5 }).scrollLeft,
    ).toBe(-50);
    expect(
      anchoredZoomScroll({ ...input, minScrollLeft: -20 }).scrollLeft,
    ).toBe(-20);
  });
});

describe("anchoredZoomScroll at the ceiling", () => {
  it("stops at the session's max and anchors at the clamped zoom", () => {
    const { zoom, scrollLeft } = anchoredZoomScroll({
      currentZoom: 40000,
      nextZoom: 50000,
      clientX: 400,
      rectLeft: 0,
      scrollLeft: 1_000_000,
      sessionSec: 60,
    });
    expect(zoom).toBe(48000);
    // 1,000,400 px at 40,000 px/s is 25.01 s: still under the pointer.
    expect((400 + scrollLeft) / zoom).toBeCloseTo(25.01, 9);
  });
});
