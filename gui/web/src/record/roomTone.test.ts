import { describe, expect, it } from "vitest";
import { rmsDbfs, roomToneReady, roomToneTooLoud } from "./roomTone";

describe("roomTone", () => {
  it("flags RMS above -35 dBFS as too loud", () => {
    const loud = new Float32Array(32).fill(0.1);
    const quiet = new Float32Array(32).fill(0.001);
    expect(rmsDbfs(loud)).toBeGreaterThan(-35);
    expect(roomToneTooLoud(loud)).toBe(true);
    expect(roomToneTooLoud(quiet)).toBe(false);
    expect(rmsDbfs(new Float32Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("treats recorded, skipped, and too_loud as ready for consent", () => {
    expect(roomToneReady("idle")).toBe(false);
    expect(roomToneReady("capturing")).toBe(false);
    expect(roomToneReady("recorded")).toBe(true);
    expect(roomToneReady("skipped")).toBe(true);
    expect(roomToneReady("too_loud")).toBe(true);
  });
});
