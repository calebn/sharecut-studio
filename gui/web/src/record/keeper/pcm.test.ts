import { describe, expect, it } from "vitest";
import { parseWavHeader, pcmWavHeader } from "../../audio/wavHeader";
import {
  encodeKeeperPcm,
  floatToInt16,
  isKeeperPcmFormat,
  KEEPER_CLIP_THRESHOLD,
  resampleLinear,
  toKeeperPcm,
} from "./pcm";

describe("isKeeperPcmFormat", () => {
  const keeper = parseWavHeader(pcmWavHeader(0).buffer);
  it("accepts the recorder's 48 kHz mono 16-bit PCM", () => {
    expect(isKeeperPcmFormat(keeper)).toBe(true);
  });
  it.each([
    ["float", { audioFormat: 3 }],
    ["stereo", { channels: 2 }],
    ["44.1 kHz", { sampleRate: 44_100 }],
    ["24-bit", { bitsPerSample: 24 }],
    ["odd block align", { blockAlign: 4 }],
  ])("rejects %s", (_label, change) => {
    expect(isKeeperPcmFormat({ ...keeper, ...change })).toBe(false);
  });
});

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

describe("encodeKeeperPcm", () => {
  it("uses the shared -1 dBFS sample-peak threshold", () => {
    expect(KEEPER_CLIP_THRESHOLD).toBeCloseTo(0.891, 3);
  });

  it("reports the first and last hot sample and keeps toKeeperPcm output", () => {
    const input = new Float32Array([0, 0.1, 0.95, 0.2, -0.99, 0.1]);
    const { pcm, hot } = encodeKeeperPcm(input, 48_000);
    expect(hot).toEqual({ first: 2, last: 4 });
    expect(Array.from(pcm)).toEqual(Array.from(toKeeperPcm(input, 48_000)));
  });

  it("reports no hot span for quiet or muted input", () => {
    expect(
      encodeKeeperPcm(new Float32Array([0.5, -0.5]), 48_000).hot,
    ).toBeNull();
    const muted = encodeKeeperPcm(new Float32Array([1, 1]), 48_000, {
      muted: true,
    });
    expect(muted.hot).toBeNull();
    expect(Array.from(muted.pcm)).toEqual([0, 0]);
  });

  it("honors a custom threshold and resamples first", () => {
    const { hot } = encodeKeeperPcm(new Float32Array([0.5, 0.5]), 24_000, {
      clipThreshold: 0.4,
    });
    expect(hot).toEqual({ first: 0, last: 3 });
  });
});
