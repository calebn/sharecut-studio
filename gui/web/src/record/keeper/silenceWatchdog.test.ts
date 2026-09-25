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
    for (let t = 1000; t <= 4000; t += 1000) expect(w.tick(t)).toBe(false);
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
    for (let t = 9000; t <= 12000; t += 1000) expect(w.tick(t)).toBe(false);
    expect(w.tick(13000)).toBe(true);
  });
  it("restarts the silence window after a late tick (sleep)", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    expect(w.tick(1000)).toBe(false);
    expect(w.tick(31000)).toBe(false);
    for (let t = 32000; t <= 35000; t += 1000) expect(w.tick(t)).toBe(false);
    expect(w.tick(36000)).toBe(true);
  });
  it("flags a re-alarm that follows a healthy check until real signal", () => {
    const w = new SilentPcmWatchdog();
    w.arm(0);
    for (let t = 1000; t <= 5000; t += 1000) w.tick(t);
    w.recheck(5500);
    expect(w.isAlarmed).toBe(false);
    for (let t = 6500; t <= 9500; t += 1000) expect(w.tick(t)).toBe(false);
    expect(w.tick(10500)).toBe(true);
    expect(w.silentSinceCheck).toBe(true);
    w.observe(quiet, 11000);
    expect(w.silentSinceCheck).toBe(false);
    w.recheck(12000);
    w.disarm();
    expect(w.silentSinceCheck).toBe(false);
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
