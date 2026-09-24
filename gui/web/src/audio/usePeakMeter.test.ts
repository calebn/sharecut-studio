import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";
import { PEAK_HOLD_FALL_DB_PER_SEC } from "./metering";
import { type FrameReader, usePeakMeter } from "./usePeakMeter";

function constant(value: number): FrameReader {
  const frame = new Float32Array(16);
  return () => {
    frame.fill(0);
    frame[0] = value;
    return frame;
  };
}

describe("usePeakMeter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is silent and never schedules a frame without a reader", () => {
    const raf = stubRaf();
    const { result } = renderHook(() => usePeakMeter(null));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.peakHoldDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clipped).toBe(false);
  });

  it("does not raise the hold on a first frame earlier than mount", () => {
    const raf = stubRaf();
    let value = 0.5;
    const read: FrameReader = () => new Float32Array([value]);
    const { result } = renderHook(() =>
      usePeakMeter(read, { publishIntervalMs: 0 }),
    );
    act(() => raf.fire(1000));
    const held = result.current.peakHoldDb;
    value = 0;
    // An earlier timestamp must not count as negative elapsed time.
    act(() => raf.fire(900));
    expect(result.current.peakHoldDb).toBeLessThanOrEqual(held);
  });

  it("decays the hold across frames", () => {
    const raf = stubRaf();
    let value = 0.5;
    const read: FrameReader = () => new Float32Array([value]);
    const { result } = renderHook(() =>
      usePeakMeter(read, { publishIntervalMs: 0 }),
    );
    act(() => raf.fire(1000));
    value = 0;
    act(() => raf.fire(1500));
    act(() => raf.fire(2000));
    expect(result.current.peakHoldDb).toBeCloseTo(
      -6.0206 - PEAK_HOLD_FALL_DB_PER_SEC,
      3,
    );
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("throttles level commits but publishes a clip latch immediately", () => {
    const raf = stubRaf();
    let value = 0.1; // -20 dBFS
    const read: FrameReader = () => new Float32Array([value]);
    const { result } = renderHook(() => usePeakMeter(read));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    value = 0.2;
    act(() => raf.fire(1010)); // inside the publish interval
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    value = 0.95;
    act(() => raf.fire(1020)); // still inside, but the latch trips
    expect(result.current.clipped).toBe(true);
    value = 0.2;
    act(() => raf.fire(1060));
    expect(result.current.levelDb).toBeCloseTo(-13.98, 2);
  });

  it("clearClip resets the latch and it re-latches on the next hot frame", () => {
    const raf = stubRaf();
    const hot = constant(0.95);
    const { result } = renderHook(() => usePeakMeter(hot));
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);
    act(() => result.current.clearClip());
    expect(result.current.clipped).toBe(false);
    act(() => raf.fire(1016));
    expect(result.current.clipped).toBe(true);
  });

  it("resets hold and clip when the reader changes or goes null", () => {
    const raf = stubRaf();
    const { result, rerender } = renderHook(
      ({ read }: { read: FrameReader | null }) => usePeakMeter(read),
      { initialProps: { read: constant(0.95) as FrameReader | null } },
    );
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);

    rerender({ read: constant(0.001) });
    expect(result.current.clipped).toBe(false);
    expect(result.current.peakHoldDb).toBe(Number.NEGATIVE_INFINITY);
    act(() => raf.fire(1016));
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBeCloseTo(-60, 5);

    rerender({ read: null });
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(raf.cancel).toHaveBeenCalled();
  });

  it("shares one frame across meters and stops after the last reader leaves", () => {
    const raf = stubRaf();
    const loud = constant(0.5);
    const quiet = constant(0.1);
    const first = renderHook(() => usePeakMeter(loud));
    const second = renderHook(() => usePeakMeter(quiet));
    expect(raf.pendingCount()).toBe(1);
    act(() => raf.fire(1000));
    expect(first.result.current.levelDb).toBeCloseTo(-6.02, 2);
    expect(second.result.current.levelDb).toBeCloseTo(-20, 2);
    expect(raf.pendingCount()).toBe(1);
    first.unmount();
    expect(raf.pendingCount()).toBe(1);
    second.unmount();
    expect(raf.pendingCount()).toBe(0);
  });
});
