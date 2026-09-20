import { describe, expect, it } from "vitest";
import { floatToInt16, resampleLinear, toKeeperPcm } from "./pcm";

describe("floatToInt16", () => {
  it("converts and clips", () => {
    const pcm = floatToInt16(new Float32Array([0, 0.5, 1, -1, 2, -2]));
    expect(Array.from(pcm)).toEqual([0, 16384, 32767, -32768, 32767, -32768]);
  });

  it("writes zeros when muted without changing length", () => {
    const pcm = floatToInt16(new Float32Array([0.9, -0.9, 0.1]), true);
    expect(pcm.length).toBe(3);
    expect(Array.from(pcm)).toEqual([0, 0, 0]);
  });
});

describe("resampleLinear", () => {
  it("is a no-op at the same rate", () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resampleLinear(input, 48000, 48000)).toBe(input);
  });

  it("doubles length when doubling rate", () => {
    const out = resampleLinear(new Float32Array([0, 1]), 24000, 48000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0);
    expect(out[out.length - 1]).toBeCloseTo(1);
  });
});

describe("toKeeperPcm", () => {
  it("resamples then mutes", () => {
    const pcm = toKeeperPcm(new Float32Array([1, 1]), 24000, true);
    expect(pcm.length).toBe(4);
    expect(pcm.every((s) => s === 0)).toBe(true);
  });
});
