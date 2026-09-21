import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInputPeakDb } from "./useInputPeakDb";

type RafCallback = (t: number) => void;

function stubRaf() {
  const callbacks: RafCallback[] = [];
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: RafCallback) => {
    callbacks.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return {
    callbacks,
    fire(t: number) {
      // Copy: tick() schedules the next frame while running.
      const pending = callbacks.splice(0, callbacks.length);
      for (const cb of pending) cb(t);
    },
  };
}

function stubAudioContext(peakValue: number) {
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData: (arr: Float32Array) => {
      arr.fill(0);
      arr[0] = peakValue;
    },
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const ctx = {
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    close: vi.fn(),
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => ctx),
  );
  return { ctx, source };
}

describe("useInputPeakDb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports silence as -Infinity with no clip latched", () => {
    const raf = stubRaf();
    stubAudioContext(0);
    const { result } = renderHook(() => useInputPeakDb({} as MediaStream));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.peakHoldDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
  });

  it("measures the true peak and latches clip at the -1 dBFS default", () => {
    const raf = stubRaf();
    stubAudioContext(0.9); // 20*log10(0.9) ≈ -0.92 dBFS ≥ -1 → clips
    const { result } = renderHook(() => useInputPeakDb({} as MediaStream));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBeCloseTo(-0.915, 2);
    expect(result.current.clipped).toBe(true);
    // Peak hold jumps straight to the new peak.
    expect(result.current.peakHoldDb).toBeCloseTo(-0.915, 2);
  });

  it("does not latch clip for a hot-but-safe peak", () => {
    const raf = stubRaf();
    stubAudioContext(0.7); // ≈ -3.1 dBFS: red zone, but not clipping
    const { result } = renderHook(() => useInputPeakDb({} as MediaStream));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBeCloseTo(-3.098, 2);
    expect(result.current.clipped).toBe(false);
  });

  it("clearClip resets the latch and it re-latches on the next hot peak", () => {
    const raf = stubRaf();
    stubAudioContext(0.95);
    const { result } = renderHook(() => useInputPeakDb({} as MediaStream));
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);
    act(() => result.current.clearClip());
    expect(result.current.clipped).toBe(false);
    act(() => raf.fire(1016));
    expect(result.current.clipped).toBe(true);
  });

  it("tears down the audio graph on unmount", () => {
    const raf = stubRaf();
    const { ctx, source } = stubAudioContext(0.1);
    const { unmount } = renderHook(() => useInputPeakDb({} as MediaStream));
    act(() => raf.fire(1000));
    unmount();
    expect(source.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });

  it("stays inert without a stream or an AudioContext", () => {
    stubRaf();
    const { result } = renderHook(() => useInputPeakDb(null));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
  });
});
