import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { type PollVerdict, usePollWhileVisible } from "./usePollWhileVisible";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

type Props = {
  enabled?: boolean;
  fetcher: (signal: AbortSignal) => Promise<number>;
  onResult?: (value: number) => PollVerdict | undefined;
  onError?: (error: unknown) => PollVerdict | undefined;
};

function mount(props: Props) {
  return renderHook(
    (p: Props) =>
      usePollWhileVisible({
        enabled: p.enabled ?? true,
        intervalMs: 3000,
        fetcher: p.fetcher,
        onResult: p.onResult ?? (() => undefined),
        onError: p.onError ?? (() => undefined),
      }),
    { initialProps: props },
  );
}

describe("usePollWhileVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("reads at once, then every interval", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("never reads while disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs no timer while hidden, and reads at once on return", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher });
    await act(async () => {});
    act(() => setVisibility("hidden"));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility("visible"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reads at once when the window regains focus", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher });
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("starts hidden with no read, then reads on becoming visible", async () => {
    setVisibility("hidden");
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher });
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => setVisibility("visible"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps one read in flight", async () => {
    const pending = deferred<number>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    mount({ fetcher });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(1));
  });

  it("drops an answer that lands after unmount and aborts the read", async () => {
    const pending = deferred<number>();
    let seen: AbortSignal | undefined;
    const fetcher = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return pending.promise;
    });
    const onResult = vi.fn();
    const view = mount({ fetcher, onResult });
    await act(async () => {});
    view.unmount();
    expect(seen?.aborted).toBe(true);
    await act(async () => pending.resolve(5));
    expect(onResult).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops an answer that lands after the poll is disabled", async () => {
    const pending = deferred<number>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    const onResult = vi.fn();
    const view = mount({ fetcher, onResult });
    await act(async () => {});
    view.rerender({ fetcher, onResult, enabled: false });
    await act(async () => pending.resolve(5));
    expect(onResult).not.toHaveBeenCalled();
  });

  it("ends on a stop verdict and ignores focus afterwards", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, onResult: () => "stop" });
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
      window.dispatchEvent(new Event("focus"));
      setVisibility("hidden");
      setVisibility("visible");
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts over when enabled flips off and on", async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    const onResult = vi.fn(() => "stop" as const);
    const view = mount({ fetcher, onResult });
    await act(async () => {});
    view.rerender({ fetcher, onResult, enabled: false });
    view.rerender({ fetcher, onResult, enabled: true });
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after an error unless told to stop", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("down"));
    const onError = vi.fn();
    mount({ fetcher, onError });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onError).toHaveBeenCalledTimes(2);
    const stopping = vi.fn().mockRejectedValue(new Error("403"));
    mount({ fetcher: stopping, onError: () => "stop" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(stopping).toHaveBeenCalledTimes(1);
  });

  it("uses the newest callbacks without restarting", async () => {
    const first = vi.fn().mockResolvedValue(1);
    const next = vi.fn().mockResolvedValue(2);
    const view = mount({ fetcher: first });
    await act(async () => {});
    view.rerender({ fetcher: next });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps one live poller through the StrictMode effect replay", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return (signals.length === 1 ? first : second).promise;
    });
    const onResult = vi.fn(() => undefined);
    renderHook(
      () =>
        usePollWhileVisible({
          enabled: true,
          intervalMs: 3000,
          fetcher,
          onResult,
          onError: () => undefined,
        }),
      { wrapper: StrictMode },
    );
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      first.resolve(1);
    });
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve(2);
    });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after a read times out", async () => {
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<number>>()
      .mockRejectedValueOnce(new DOMException("x", "TimeoutError"))
      .mockResolvedValue(2);
    const onError = vi.fn(() => undefined);
    const onResult = vi.fn(() => undefined);
    mount({ fetcher, onError, onResult });
    await act(async () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onResult).toHaveBeenCalledWith(2);
  });
});
