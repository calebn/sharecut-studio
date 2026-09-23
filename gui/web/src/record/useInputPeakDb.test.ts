import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";
import { INPUT_METER_FFT_SIZE, useInputPeakDb } from "./useInputPeakDb";

type StubOptions = {
  state?: AudioContextState;
  global?: "AudioContext" | "webkitAudioContext";
  throwOnSource?: boolean;
};

function stubAudioContext(
  peakValue: number,
  {
    state = "running",
    global = "AudioContext",
    throwOnSource,
  }: StubOptions = {},
) {
  const analyser = {
    fftSize: 2048,
    getFloatTimeDomainData: (arr: Float32Array) => {
      arr.fill(0);
      arr[0] = peakValue;
    },
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const listeners = new Set<() => void>();
  const ctx = {
    state,
    createMediaStreamSource: vi.fn(() => {
      if (throwOnSource)
        throw new DOMException("no audio track", "InvalidStateError");
      return source;
    }),
    createAnalyser: vi.fn(() => analyser),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) =>
      listeners.delete(fn),
    ),
    setState(next: AudioContextState) {
      ctx.state = next;
      for (const fn of listeners) fn();
    },
  };
  const Ctor = vi.fn(() => ctx);
  vi.stubGlobal("AudioContext", global === "AudioContext" ? Ctor : undefined);
  vi.stubGlobal(
    "webkitAudioContext",
    global === "webkitAudioContext" ? Ctor : undefined,
  );
  return { ctx, source, analyser, Ctor };
}

const micA = {} as MediaStream;
const micB = {} as MediaStream;

describe("useInputPeakDb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports silence as -Infinity with no clip latched", () => {
    const raf = stubRaf();
    stubAudioContext(0);
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.peakHoldDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
  });

  it("measures the sample peak and latches clip at the -1 dBFS default", () => {
    const raf = stubRaf();
    const { analyser } = stubAudioContext(0.9); // ≈ -0.92 dBFS ≥ -1 → clips
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(analyser.fftSize).toBe(INPUT_METER_FFT_SIZE);
    expect(result.current.levelDb).toBeCloseTo(-0.915, 2);
    expect(result.current.clipped).toBe(true);
    // Peak hold jumps straight to the new peak.
    expect(result.current.peakHoldDb).toBeCloseTo(-0.915, 2);
  });

  it("does not latch clip for a hot-but-safe peak", () => {
    const raf = stubRaf();
    stubAudioContext(0.7); // ≈ -3.1 dBFS: red zone, but not clipping
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBeCloseTo(-3.098, 2);
    expect(result.current.clipped).toBe(false);
  });

  it("honors a custom clipDb", () => {
    const raf = stubRaf();
    stubAudioContext(0.7); // ≈ -3.1 dBFS
    const { result } = renderHook(() => useInputPeakDb(micA, { clipDb: -6 }));
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);
  });

  it("clearClip resets the latch and it re-latches on the next hot peak", () => {
    const raf = stubRaf();
    stubAudioContext(0.95);
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);
    act(() => result.current.clearClip());
    expect(result.current.clipped).toBe(false);
    act(() => raf.fire(1016));
    expect(result.current.clipped).toBe(true);
  });

  it("resets the meter when the stream switches or goes null", () => {
    const raf = stubRaf();
    const { ctx } = stubAudioContext(0.95);
    const { result, rerender } = renderHook(
      ({ stream }: { stream: MediaStream | null }) => useInputPeakDb(stream),
      { initialProps: { stream: micA as MediaStream | null } },
    );
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);

    rerender({ stream: micB });
    expect(result.current.clipped).toBe(false);
    expect(result.current.peakHoldDb).toBe(Number.NEGATIVE_INFINITY);
    expect(ctx.close).toHaveBeenCalledTimes(1);

    rerender({ stream: null });
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
    expect(ctx.close).toHaveBeenCalledTimes(2);
  });

  it("tears down the audio graph on unmount", () => {
    const raf = stubRaf();
    const { ctx, source } = stubAudioContext(0.1);
    const { unmount } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    unmount();
    expect(source.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    expect(ctx.removeEventListener).toHaveBeenCalled();
  });

  it("swallows a rejected close()", async () => {
    stubRaf();
    const { ctx } = stubAudioContext(0.1);
    ctx.close.mockImplementation(() => Promise.reject(new Error("closed")));
    const { unmount } = renderHook(() => useInputPeakDb(micA));
    unmount();
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalled();
  });

  it("stays inert and closes the context when graph construction throws", () => {
    const raf = stubRaf();
    const { ctx } = stubAudioContext(0.9, { throwOnSource: true });
    const { result, unmount } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    unmount();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("stays inert without a stream", () => {
    stubRaf();
    const { Ctor } = stubAudioContext(0.9);
    const { result } = renderHook(() => useInputPeakDb(null));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
    expect(Ctor).not.toHaveBeenCalled();
  });

  it("stays inert without any AudioContext", () => {
    const raf = stubRaf();
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.suspended).toBe(false);
    act(() => result.current.resume()); // no context: a no-op, not a throw
  });

  it("falls back to webkitAudioContext", () => {
    const raf = stubRaf();
    const { Ctor } = stubAudioContext(0.5, { global: "webkitAudioContext" });
    const { result } = renderHook(() => useInputPeakDb(micA));
    act(() => raf.fire(1000));
    expect(Ctor).toHaveBeenCalled();
    expect(result.current.levelDb).toBeCloseTo(-6.02, 2);
  });

  it("resumes a suspended context and exposes the suspended flag", () => {
    stubRaf();
    const { ctx } = stubAudioContext(0.5, { state: "suspended" });
    const { result } = renderHook(() => useInputPeakDb(micA));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(result.current.suspended).toBe(true);

    act(() => ctx.setState("running"));
    expect(result.current.suspended).toBe(false);

    act(() => ctx.setState("interrupted" as AudioContextState));
    expect(result.current.suspended).toBe(true);
    act(() => result.current.resume());
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });
});
