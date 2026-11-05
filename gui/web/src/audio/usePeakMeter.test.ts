import { act, renderHook } from "@testing-library/react";
import { createElement, Suspense, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";
import { PEAK_HOLD_FALL_DB_PER_SEC } from "./metering";
import {
  type FrameReader,
  type PeakMeterOptions,
  usePeakMeter,
} from "./usePeakMeter";

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
    let value = 0.1;
    const read: FrameReader = () => new Float32Array([value]);
    const { result } = renderHook(() => usePeakMeter(read));
    act(() => raf.fire(1000));
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    value = 0.2;
    act(() => raf.fire(1010));
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    value = 0.95;
    act(() => raf.fire(1020));
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

  it("keeps a healthy meter running after another reader throws", () => {
    const raf = stubRaf();
    const diagnostic = vi.fn();
    vi.stubGlobal("reportError", diagnostic);
    const broken = renderHook(() =>
      usePeakMeter(() => {
        throw new Error("reader failed");
      }),
    );
    const goodReader = constant(0.5);
    const healthy = renderHook(() => usePeakMeter(goodReader));
    act(() => raf.fire(1000));
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(healthy.result.current.levelDb).toBeCloseTo(-6.02, 2);
    expect(raf.pendingCount()).toBe(1);
    act(() => raf.fire(1016));
    expect(raf.pendingCount()).toBe(1);
    broken.unmount();
    healthy.unmount();
  });
  it("retains command identities across reader and analysis-option replacement", () => {
    const raf = stubRaf();
    const { result, rerender } = renderHook(
      ({ read, clipDb }) => usePeakMeter(read, { clipDb }),
      { initialProps: { read: constant(0.99), clipDb: -1 } },
    );
    const clear = result.current.clearClip;
    const latch = result.current.latchClip;
    act(() => raf.fire(1000));
    expect(result.current.clipped).toBe(true);
    rerender({ read: constant(0.1), clipDb: -3 });
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    expect(result.current.clearClip).toBe(clear);
    expect(result.current.latchClip).toBe(latch);
    act(() => latch());
    expect(result.current.clipped).toBe(true);
  });

  it("accepts same-event sticky clip commands without a frame reader", () => {
    const { result } = renderHook(() => usePeakMeter(null));
    const clear = result.current.clearClip;
    const latch = result.current.latchClip;
    act(() => {
      latch();
      clear();
      latch();
    });
    expect(result.current.clipped).toBe(true);
    act(() => {
      clear();
      latch();
      clear();
    });
    expect(result.current.clipped).toBe(false);
  });
  it("keeps analysed-but-throttled values out of explicit clip publications", () => {
    const raf = stubRaf();
    let amplitude = 0.1;
    const reader: FrameReader = () => [amplitude];
    const { result } = renderHook(() => usePeakMeter(reader));
    act(() => raf.fire(0));
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    amplitude = 0.2;
    act(() => raf.fire(10));
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    act(() => result.current.latchClip());
    expect(result.current.clipped).toBe(true);
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    expect(result.current.peakHoldDb).toBeCloseTo(-20, 5);
    act(() => result.current.clearClip());
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBeCloseTo(-20, 5);
    act(() => raf.fire(33));
    expect(result.current.levelDb).toBeCloseTo(-13.9794, 4);
  });

  it("resets every committed reader entry even when returning to the same function", () => {
    const raf = stubRaf();
    const first = constant(0.99);
    const second = constant(0.1);
    const { result, rerender } = renderHook(({ read }) => usePeakMeter(read), {
      initialProps: { read: first },
    });
    act(() => raf.fire(0));
    expect(result.current.clipped).toBe(true);
    rerender({ read: second });
    act(() => raf.fire(10));
    expect(result.current.levelDb).toBeCloseTo(-20, 4);
    rerender({ read: first });
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it.each([
    { name: "clip threshold", options: { clipDb: -3 } },
    { name: "hold fall rate", options: { fallDbPerSec: 10 } },
    { name: "floor", options: { floorDb: -80 } },
    { name: "publication interval", options: { publishIntervalMs: 100 } },
  ])("resets hold and clip for a changed $name", ({ options }) => {
    const raf = stubRaf();
    const reader = constant(0.99);
    const initialProps: { options: PeakMeterOptions } = { options: {} };
    const { result, rerender } = renderHook(
      ({ options }) => usePeakMeter(reader, options),
      { initialProps },
    );
    act(() => raf.fire(0));
    expect(result.current.clipped).toBe(true);
    rerender({ options });
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("keeps the committed reader active through an abandoned replacement render", () => {
    const raf = stubRaf();
    const first = vi.fn(constant(0.5));
    const second = vi.fn(constant(0.99));
    const pending = new Promise<void>(() => {});
    const { result, rerender, unmount } = renderHook(
      ({ read, suspend }) => {
        const value = usePeakMeter(read);
        if (suspend) throw pending;
        return value;
      },
      {
        initialProps: { read: first, suspend: false },
        wrapper: ({ children }) =>
          createElement(Suspense, { fallback: null }, children),
      },
    );
    act(() => raf.fire(0));
    const cancelled = raf.cancel.mock.calls.length;
    rerender({ read: second, suspend: true });
    expect(second).not.toHaveBeenCalled();
    expect(raf.cancel).toHaveBeenCalledTimes(cancelled);
    act(() => raf.fire(16));
    expect(first).toHaveBeenCalledTimes(2);
    rerender({ read: first, suspend: false });
    expect(result.current.levelDb).toBeCloseTo(-6.0206, 4);
    expect(raf.cancel).toHaveBeenCalledTimes(cancelled);
    unmount();
    expect(raf.pendingCount()).toBe(0);
  });
  it("accepts a silent inline reader across unrelated parent rerenders", () => {
    stubRaf();
    const { result, rerender } = renderHook(
      ({ amplitude }) => usePeakMeter(() => [amplitude]),
      { initialProps: { amplitude: 0 } },
    );
    rerender({ amplitude: 0 });
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });
  it("resets a frame when parent rerenders commit reader round trips", () => {
    const raf = stubRaf();
    const first = constant(0.99);
    const second = constant(0.1);
    const { result, rerender } = renderHook(({ read }) => usePeakMeter(read), {
      initialProps: { read: first },
    });
    act(() => {
      raf.fire(0);
      flushSync(() => rerender({ read: second }));
      flushSync(() => rerender({ read: first }));
      expect(raf.cancel).toHaveBeenCalledTimes(2);
    });
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("resets a frame when public state commands commit reader round trips", () => {
    const raf = stubRaf();
    const first = constant(0.99);
    const second = constant(0.1);
    const { result } = renderHook(() => {
      const [read, setRead] = useState<FrameReader>(() => first);
      return { ...usePeakMeter(read), read, setRead };
    });
    act(() => {
      raf.fire(0);
      flushSync(() => result.current.setRead(() => second));
      expect(result.current.read).toBe(second);
      flushSync(() => result.current.setRead(() => first));
      expect(result.current.read).toBe(first);
      expect(raf.cancel).toHaveBeenCalledTimes(2);
    });
    expect(result.current.clipped).toBe(false);
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });
});
