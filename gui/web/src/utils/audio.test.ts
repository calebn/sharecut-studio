import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioContextCtor,
  clampFaderDb,
  dbToLinear,
  formatGainDb,
  linearToDb,
  trackIsAudible,
  trackMuteState,
  trackOutputGainDb,
} from "./audio";

describe("linearToDb", () => {
  it("inverts dbToLinear", () => {
    expect(linearToDb(dbToLinear(-18))).toBeCloseTo(-18, 10);
    expect(linearToDb(1)).toBe(0);
  });

  it("maps silence and non-positive input to -Infinity", () => {
    expect(linearToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(linearToDb(-0.5)).toBe(Number.NEGATIVE_INFINITY);
    expect(linearToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("audioContextCtor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the standard AudioContext", () => {
    const Std = vi.fn();
    vi.stubGlobal("AudioContext", Std);
    vi.stubGlobal("webkitAudioContext", vi.fn());
    expect(audioContextCtor()).toBe(Std);
  });

  it("falls back to webkitAudioContext", () => {
    const Webkit = vi.fn();
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", Webkit);
    expect(audioContextCtor()).toBe(Webkit);
  });

  it("returns undefined without Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(audioContextCtor()).toBeUndefined();
  });
});

describe("trackMuteState", () => {
  const none: Record<string, boolean> = {};

  it("ranks the saved mute over a listen mute over an implied one", () => {
    expect(trackMuteState("a", true, { a: true }, { b: true })).toBe("saved");
    expect(trackMuteState("a", false, { a: true }, { b: true })).toBe("listen");
    expect(trackMuteState("a", false, none, { b: true })).toBe("implied");
    expect(trackMuteState("a", false, none, { a: true })).toBe("off");
    expect(trackMuteState("a", false, none, none)).toBe("off");
  });

  it("never lets solo bring back a saved mute", () => {
    expect(trackIsAudible("a", true, none, { a: true })).toBe(false);
    expect(trackIsAudible("a", false, { a: true }, { a: true })).toBe(false);
    expect(trackIsAudible("a", false, none, { a: true })).toBe(true);
    expect(trackIsAudible("b", false, none, { a: true })).toBe(false);
  });
});

describe("saved volume helpers", () => {
  it("add the volume to the staging gain and clamp it to the range", () => {
    expect(trackOutputGainDb({ gain_db: -2, fader_db: -3.5 })).toBe(-5.5);
    expect(trackOutputGainDb({ gain_db: -2 })).toBe(-2);
    expect(clampFaderDb(40)).toBe(12);
    expect(clampFaderDb(-99)).toBe(-60);
  });

  it("label gain with a sign and a true minus", () => {
    expect(formatGainDb(1.5)).toBe("+1.5 dB");
    expect(formatGainDb(-3)).toBe("\u22123.0 dB");
    expect(formatGainDb(-0.04)).toBe("0.0 dB");
  });
});
