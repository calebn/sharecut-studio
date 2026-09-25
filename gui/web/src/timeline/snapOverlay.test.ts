import { describe, expect, it } from "vitest";
import { magnetSec, uniqueTicks } from "./snapOverlay";

describe("uniqueTicks", () => {
  it("merges ticks within 1 µs, like the server", () => {
    expect(uniqueTicks([1.01002, 1.0100204, 0.5])).toEqual([0.5, 1.01002]);
  });

  it("keeps ticks 20 µs apart distinct for near-sample zoom", () => {
    expect(uniqueTicks([1.01002, 1.01])).toEqual([1.01, 1.01002]);
  });
});

describe("magnetSec", () => {
  it("snaps to a tick within the pixel radius at deep zoom", () => {
    // 10 µs is 0.48 px at 48,000 px/s: inside the 8 px magnet.
    expect(magnetSec(1.00001, [1], 48000)).toBe(1);
    // 1 ms is 48 px away: no snap.
    expect(magnetSec(1.001, [1], 48000)).toBe(1.001);
  });
});
