import { afterEach, describe, expect, it, vi } from "vitest";
import { audioContextCtor, dbToLinear, linearToDb } from "./audio";

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
