import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { StrictMode, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActiveElapsedSample, createWallSample } from "./sampledClocks";
import { useElapsedSince } from "./useElapsedSince";
import { startInterval } from "./useIntervalTick";
import { useNowSec } from "./useNowSec";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sampled clock ownership", () => {
  it("keeps snapshot reads cached and subscription identities stable", () => {
    const read = vi.spyOn(Date, "now").mockReturnValue(42000);
    const clock = createWallSample();
    const get = clock.getSnapshot;
    const subscribe = clock.subscribe;
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    read.mockReturnValue(43000);
    expect(get()).toBe(42);
    expect(get()).toBe(42);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const inactive = clock.connect(false);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const active = clock.connect(true);
    expect(get()).toBe(43);
    expect(read).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(clock.getSnapshot).toBe(get);
    expect(clock.subscribe).toBe(subscribe);
    active();
    inactive();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts nullable elapsed wall time only at active acquisition and caches reads", () => {
    const read = vi.spyOn(Date, "now").mockReturnValue(10000);
    const clock = createActiveElapsedSample();
    const get = clock.getSnapshot;
    const subscribe = clock.subscribe;
    expect(get()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const idle = clock.connect(false);
    expect(read).not.toHaveBeenCalled();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const active = clock.connect(true);
    expect(read).toHaveBeenCalledOnce();
    expect(get()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    read.mockReturnValue(15000);
    expect(get()).toBe(0);
    expect(get()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(get()).toBe(5);
    read.mockReturnValue(9000);
    vi.advanceTimersByTime(1000);
    expect(get()).toBe(-1);
    active();
    const inactive = clock.connect(false);
    expect(get()).toBeNull();
    expect(clock.getSnapshot).toBe(get);
    expect(clock.subscribe).toBe(subscribe);
    expect(listener).toHaveBeenCalledTimes(4);
    inactive();
    idle();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a replacement elapsed acquisition safe from the retired callback and cleanup", () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      "setInterval",
      vi.fn((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    const clear = vi.fn();
    vi.stubGlobal("clearInterval", clear);
    const read = vi.spyOn(Date, "now").mockReturnValue(10000);
    const clock = createActiveElapsedSample();
    const old = clock.connect(true);
    old();
    read.mockReturnValue(20000);
    const current = clock.connect(true);
    read.mockReturnValue(25000);
    callbacks[0]();
    old();
    expect(clock.getSnapshot()).toBe(0);
    expect(clear).toHaveBeenCalledTimes(1);
    callbacks[1]();
    expect(clock.getSnapshot()).toBe(5);
    current();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("rejects a retained released interval callback and disposes its native id once", () => {
    const callbacks: (() => void)[] = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return 42;
    });
    const clear = vi.fn();
    vi.stubGlobal("setInterval", schedule);
    vi.stubGlobal("clearInterval", clear);
    const tick = vi.fn();
    const release = startInterval(1000, tick);
    try {
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1000);
      callbacks[0]();
      expect(tick).toHaveBeenCalledOnce();
      release();
      release();
      callbacks[0]();
      expect(tick).toHaveBeenCalledOnce();
      expect(clear).toHaveBeenCalledExactlyOnceWith(42);
    } finally {
      release();
    }
  });

  it("owns exactly one timer per active consumer after StrictMode replay", () => {
    const { unmount } = renderHook(
      () => {
        useNowSec(true);
        useElapsedSince(0, true);
      },
      { wrapper: StrictMode },
    );
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acquires no intervals for an abandoned suspended render", () => {
    const scheduled = vi.spyOn(window, "setInterval");
    const pending = new Promise<void>(() => {});
    function UncommittedClock(): never {
      useNowSec(true);
      useElapsedSince(0, true);
      throw pending;
    }
    const view = render(
      <Suspense fallback={<p>Waiting</p>}>
        <UncommittedClock />
      </Suspense>,
    );
    expect(screen.getByText("Waiting")).toBeVisible();
    expect(scheduled).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
