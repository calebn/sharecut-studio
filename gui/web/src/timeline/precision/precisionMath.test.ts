import { describe, expect, it } from "vitest";
import {
  deltaText,
  frameOf,
  gripPxPerSec,
  jogGain,
  jogGainIndex,
  lensPxPerSec,
  quantize,
  unitsPerSec,
} from "./precisionMath";

const trim = {
  kind: "trim",
  trackId: "t",
  clipId: "c",
  edge: "out",
} as const;
const fadeIn = { ...trim, kind: "fade", edge: "in" } as const;
const fadeOut = { ...trim, kind: "fade", edge: "out" } as const;

describe("precision math", () => {
  it("slows the jog one step for every 40 px the finger rises", () => {
    expect([-30, 0, 39, 40, 79, 80, 120, 400].map(jogGainIndex)).toEqual([
      0, 0, 0, 1, 1, 2, 3, 3,
    ]);
  });

  it("keeps a fine step 8 px wide however far out the zoom is", () => {
    expect(jogGain(3, 10, 0.01)).toBe(0.0125);
    expect(jogGain(3, 200, 0.01)).toBe(0.125);
    expect(jogGain(1, 10, 0.01)).toBe(0.5);
  });

  it("fits ±1 s of the lens into the time column", () => {
    expect(lensPxPerSec(326)).toBe(163);
  });

  it("never lets the grip's loupe show less than 200 px per second", () => {
    expect(gripPxPerSec(12)).toBe(200);
    expect(gripPxPerSec(480)).toBe(480);
  });

  it("steps a trim by 10 ms and a fade by 1 ms", () => {
    expect(frameOf(trim)).toBe(0.01);
    expect(frameOf(fadeIn)).toBe(1);
  });

  it("moves a fade-out corner against its value", () => {
    expect(unitsPerSec(trim)).toBe(1);
    expect(unitsPerSec(fadeIn)).toBe(1000);
    expect(unitsPerSec(fadeOut)).toBe(-1000);
  });

  it("lands on whole steps counted from the origin", () => {
    expect(quantize(50.0149, 50.003, 0.01)).toBe(50.013);
    expect(quantize(50.0181, 50.003, 0.01)).toBe(50.023);
    expect(quantize(49.9951, 50.003, 0.01)).toBe(49.993);
  });

  it("reads how far it moved in ms, and in seconds past one", () => {
    expect(deltaText(trim, 60, 59.99)).toBe("−10 ms");
    expect(deltaText(trim, 40, 46.18)).toBe("+6.18 s");
    expect(deltaText(fadeIn, 300, 301)).toBe("+1 ms");
    expect(deltaText(fadeOut, 300, 1504)).toBe("+1.204 s");
    expect(deltaText(trim, 10, 10)).toBe("+0 ms");
  });
});
