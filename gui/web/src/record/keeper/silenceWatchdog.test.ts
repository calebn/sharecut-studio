import { describe, expect, it } from "vitest";
import { pcmHasSignal, SilentPcmWatchdog } from "./silenceWatchdog";

const zeros = new Float32Array(128);
const quiet = new Float32Array(128).fill(1e-5);

describe("pcmHasSignal", () => {
  it("ignores zeros and sub-floor noise", () => {
    expect(pcmHasSignal(zeros)).toBe(false);
    expect(pcmHasSignal(new Float32Array(8).fill(2 ** -25))).toBe(false);
  });
  it("detects quiet and single-sample signal", () => {
    expect(pcmHasSignal(quiet)).toBe(true);
    const one = new Float32Array(128);
    one[64] = -1e-4;
    expect(pcmHasSignal(one)).toBe(true);
  });
});

describe("SilentPcmWatchdog", () => {
  it("alarms on zero PCM at 5s, once", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    for (let t = 1000; t <= 4000; t += 1000) {
      w.observe(zeros, t);
      expect(w.tick(t)).toBe(false);
    }
    w.observe(zeros, 5000);
    expect(w.tick(5000)).toBe(true);
    expect(w.tick(6000)).toBe(false);
    expect(w.isAlarmed).toBe(true);
  });
  it("alarms on missing PCM", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    expect(w.tick(4000)).toBe(false);
    expect(w.tick(5000)).toBe(true);
  });
  it("never alarms on genuine quiet", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    for (let t = 1000; t <= 20000; t += 1000) {
      w.observe(quiet, t);
      expect(w.tick(t)).toBe(false);
    }
  });
  it("recovers on real signal once", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    for (let t = 1000; t <= 5000; t += 1000) w.tick(t);
    expect(w.observe(quiet, 5500)).toBe(true);
    expect(w.observe(quiet, 5600)).toBe(false);
    expect(w.isAlarmed).toBe(false);
  });
  it("ignores late ticks", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    expect(w.tick(1000)).toBe(false);
    expect(w.tick(2000)).toBe(false);
    expect(w.tick(8000)).toBe(false);
    expect(w.tick(9000)).toBe(true);
  });
  it("disarm and arm reset state", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    for (let t = 1000; t <= 5000; t += 1000) w.tick(t);
    expect(w.isAlarmed).toBe(true);
    w.disarm();
    expect(w.isArmed).toBe(false);
    expect(w.isAlarmed).toBe(false);
    expect(w.tick(9000)).toBe(false);
    w.arm(10000);
    expect(w.tick(12000)).toBe(false);
  });
});
