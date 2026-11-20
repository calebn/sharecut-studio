import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keeperAudioConstraints } from "./keeper/constraints";
import { MIC_PROMPT_SLOW_MS } from "./micPermission";
import { useMicPermission } from "./useMicPermission";

function stubGum(
  impl: () => Promise<{
    getTracks: () => { stop: () => void; getSettings: () => object }[];
    getAudioTracks: () => { stop: () => void; getSettings: () => object }[];
  }>,
  permissions?: { query: ReturnType<typeof vi.fn> },
): ReturnType<typeof vi.fn> {
  const gum = vi.fn(impl);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: gum,
      enumerateDevices: vi.fn(async () => []),
    },
    permissions,
  });
  return gum;
}

const dryTrack = {
  stop: vi.fn(),
  getSettings: () => ({
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
  }),
};

describe("useMicPermission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays idle until request and reuses useMicStream constraints", async () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result } = renderHook(() => useMicPermission(true, ""));
    expect(result.current.status).toBe("idle");
    expect(gum).not.toHaveBeenCalled();
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
    expect(gum).toHaveBeenCalledWith(keeperAudioConstraints(""));
  });

  it("reports a lost grant and keeps it lost after a failed retry", async () => {
    let ended: (() => void) | undefined;
    let rejectRetry: ((error: Error) => void) | undefined;
    const makeTrack = () => ({
      stop: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        ended = listener;
      }),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    });
    const first = makeTrack();
    const gum = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [first],
        getAudioTracks: () => [first],
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = reject;
          }),
      );
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("granted"));
    ended?.();
    await waitFor(() => expect(result.current.status).toBe("lost"));
    result.current.retry();
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.lost).toBe(true);
    rejectRetry?.(new Error("device unavailable"));
    await waitFor(() => expect(result.current.error).toMatch(/unavailable/));
    expect(result.current.status).toBe("lost");
    expect(result.current.pending).toBe(false);
  });

  it("does not call getUserMedia when disabled", () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result } = renderHook(() => useMicPermission(false, ""));
    result.current.request();
    expect(gum).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("pre-detects denied via permissions.query without getUserMedia", async () => {
    const gum = stubGum(
      async () => ({
        getTracks: () => [dryTrack],
        getAudioTracks: () => [dryTrack],
      }),
      {
        query: vi.fn(async () => ({
          state: "denied" as PermissionState,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      },
    );
    const { result } = renderHook(() => useMicPermission(true, ""));
    await waitFor(() => {
      expect(result.current.status).toBe("denied");
    });
    expect(gum).not.toHaveBeenCalled();
  });

  it("maps query denied after request even while wantStream is true", async () => {
    let onChange: (() => void) | undefined;
    const statusObj = {
      state: "prompt" as PermissionState,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        onChange = listener;
      }),
      removeEventListener: vi.fn(),
    };
    stubGum(
      async () => ({
        getTracks: () => [dryTrack],
        getAudioTracks: () => [dryTrack],
      }),
      { query: vi.fn(async () => statusObj) },
    );
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
    statusObj.state = "denied";
    onChange?.();
    await waitFor(() => {
      expect(result.current.status).toBe("denied");
    });
    expect(result.current.stream).toBeNull();
    expect(result.current.lost).toBe(false);
  });

  it("maps NotAllowedError to denied", async () => {
    stubGum(async () => {
      const err = new Error("Permission denied");
      err.name = "NotAllowedError";
      throw err;
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("denied");
    });
  });

  it("maps NotFoundError to unavailable", async () => {
    stubGum(async () => {
      const err = new Error("Requested device not found");
      err.name = "NotFoundError";
      throw err;
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
  });

  it("surfaces unmapped getUserMedia errors as error, not denied", async () => {
    stubGum(async () => {
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBe("Could not start audio source");
  });

  it("retries getUserMedia after a denial", async () => {
    let fail = true;
    const gum = stubGum(async () => {
      if (fail) {
        const err = new Error("Permission denied");
        err.name = "NotAllowedError";
        throw err;
      }
      return {
        getTracks: () => [dryTrack],
        getAudioTracks: () => [dryTrack],
      };
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("denied");
    });
    fail = false;
    result.current.retry();
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it("treats an in-flight retry as prompting and ignores stacked retries", async () => {
    let resolveHang:
      | ((value: {
          getTracks: () => (typeof dryTrack)[];
          getAudioTracks: () => (typeof dryTrack)[];
        }) => void)
      | undefined;
    let calls = 0;
    const gum = stubGum(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("Permission denied");
        err.name = "NotAllowedError";
        return Promise.reject(err);
      }
      return new Promise((resolve) => {
        resolveHang = resolve;
      });
    });
    const { result } = renderHook(() => useMicPermission(true, ""));
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("denied");
    });
    result.current.retry();
    await waitFor(() => {
      expect(result.current.status).toBe("prompting");
    });
    result.current.retry();
    result.current.retry();
    expect(gum).toHaveBeenCalledTimes(2);
    resolveHang?.({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    });
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
  });

  it("admits a retained request after denial and coalesces same-event calls", async () => {
    let finish:
      | ((value: {
          getTracks: () => (typeof dryTrack)[];
          getAudioTracks: () => (typeof dryTrack)[];
        }) => void)
      | undefined;
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    const gum = stubGum(
      vi
        .fn()
        .mockRejectedValueOnce(denied)
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const { result } = renderHook(() => useMicPermission(true, ""));
    const request = result.current.request;
    act(() => {
      request();
      request();
      request();
    });
    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(gum).toHaveBeenCalledTimes(1);
    act(() => {
      request();
      request();
      request();
    });
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("prompting");
    await act(async () => {
      finish?.({
        getTracks: () => [dryTrack],
        getAudioTracks: () => [dryTrack],
      });
    });
    await waitFor(() => expect(result.current.status).toBe("granted"));
  });

  it("keeps a retained disabled request disabled after re-enabling", async () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicPermission(enabled, ""),
      { initialProps: { enabled: false } },
    );
    const disabledRequest = result.current.request;
    rerender({ enabled: true });
    act(() => disabledRequest());
    expect(gum).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("preserves the enabled closure of an old request through a disabled interval", async () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicPermission(enabled, ""),
      { initialProps: { enabled: true } },
    );
    const enabledRequest = result.current.request;
    rerender({ enabled: false });
    act(() => enabledRequest());
    expect(gum).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("retires explicit acquisition intent on disable and waits for a new request after re-enable", async () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicPermission(enabled, ""),
      { initialProps: { enabled: true } },
    );
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(gum).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    expect(result.current.stream).toBeNull();
    expect(result.current.status).toBe("idle");
    rerender({ enabled: true });
    expect(result.current.status).toBe("idle");
    expect(result.current.stream).toBeNull();
    expect(gum).toHaveBeenCalledTimes(1);
    act(() => result.current.request());
    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it("accepts the current request in the same event as a flushed enable", async () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result } = renderHook(() => {
      const [enabled, setEnabled] = useState(false);
      return {
        mic: useMicPermission(enabled, ""),
        enable: () => setEnabled(true),
      };
    });
    expect(gum).not.toHaveBeenCalled();
    act(() => {
      flushSync(() => result.current.enable());
      result.current.mic.request();
    });
    await waitFor(() => expect(result.current.mic.status).toBe("granted"));
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("stays granted while reopening the stream for a new device", async () => {
    let resolveSecond:
      | ((value: {
          getTracks: () => (typeof dryTrack)[];
          getAudioTracks: () => (typeof dryTrack)[];
        }) => void)
      | undefined;
    let calls = 0;
    const gum = stubGum(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          getTracks: () => [dryTrack],
          getAudioTracks: () => [dryTrack],
        });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });
    const { result, rerender } = renderHook(
      ({ deviceId }: { deviceId: string }) => useMicPermission(true, deviceId),
      { initialProps: { deviceId: "" } },
    );
    result.current.request();
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
    rerender({ deviceId: "dev-2" });
    await waitFor(() => {
      expect(gum).toHaveBeenCalledTimes(2);
    });
    expect(result.current.status).toBe("granted");
    expect(result.current.status).not.toBe("prompting");
    resolveSecond?.({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    });
    await waitFor(() => {
      expect(result.current.status).toBe("granted");
    });
  });

  it("treats a missing permissions.query as unsupported, not denied", () => {
    const gum = stubGum(async () => ({
      getTracks: () => [dryTrack],
      getAudioTracks: () => [dryTrack],
    }));
    const { result } = renderHook(() => useMicPermission(true, ""));
    expect(result.current.status).toBe("idle");
    expect(gum).not.toHaveBeenCalled();
  });
});

describe("useMicPermission slow prompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Call = {
    resolve: (stream: unknown) => void;
    reject: (error: Error) => void;
  };

  function hungGum(): { gum: ReturnType<typeof vi.fn>; calls: Call[] } {
    const calls: Call[] = [];
    const gum = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
    );
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: gum, enumerateDevices: async () => [] },
    });
    return { gum, calls };
  }

  const streamOf = (track: {
    stop: () => void;
    getSettings: () => object;
  }) => ({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("turns slow at 10 s and not a millisecond before, still prompting", async () => {
    hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS - 1);
    expect(result.current).toMatchObject({
      status: "prompting",
      promptSlow: false,
    });
    await advance(1);
    expect(result.current).toMatchObject({
      status: "prompting",
      promptSlow: true,
    });
  });

  it("is never slow before a request", async () => {
    hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    await advance(MIC_PROMPT_SLOW_MS * 3);
    expect(result.current).toMatchObject({ status: "idle", promptSlow: false });
  });

  it("asks again on Retry while slow, drops the first request and restarts the clock", async () => {
    const { gum, calls } = hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS);
    expect(result.current.promptSlow).toBe(true);
    act(() => result.current.retry());
    await advance(0);
    expect(gum).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      status: "prompting",
      promptSlow: false,
    });
    await advance(MIC_PROMPT_SLOW_MS - 1);
    expect(result.current.promptSlow).toBe(false);
    await advance(1);
    expect(result.current.promptSlow).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("asks only once for two Retry clicks in the same moment", async () => {
    const { gum } = hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS);
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    await advance(0);
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it("does not ask again on Retry before the note shows", async () => {
    const { gum } = hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS - 1);
    act(() => result.current.retry());
    await advance(0);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("stops the first request's stream when it answers after Retry and follows the second", async () => {
    const { calls } = hungGum();
    const first = { ...dryTrack, stop: vi.fn() };
    const second = { ...dryTrack, stop: vi.fn() };
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS);
    act(() => result.current.retry());
    await advance(0);
    await act(async () => calls[0].resolve(streamOf(first)));
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
    expect(result.current.status).toBe("prompting");
    await act(async () => calls[1].resolve(streamOf(second)));
    expect(result.current).toMatchObject({
      status: "granted",
      promptSlow: false,
    });
    expect(second.stop).not.toHaveBeenCalled();
  });

  it("grants late without a Retry and leaves no note", async () => {
    const { calls } = hungGum();
    const { result } = renderHook(() => useMicPermission(true, ""));
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS + 5000);
    expect(result.current.promptSlow).toBe(true);
    await act(async () => calls[0].resolve(streamOf(dryTrack)));
    expect(result.current).toMatchObject({
      status: "granted",
      promptSlow: false,
    });
    await advance(MIC_PROMPT_SLOW_MS * 2);
    expect(result.current.promptSlow).toBe(false);
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["NotFoundError", "unavailable"],
    ["NotReadableError", "error"],
  ] as const)(
    "never shows the note once the browser says %s",
    async (name, status) => {
      const { calls } = hungGum();
      const { result } = renderHook(() => useMicPermission(true, ""));
      act(() => result.current.request());
      await advance(MIC_PROMPT_SLOW_MS + 1);
      expect(result.current.promptSlow).toBe(true);
      await act(async () =>
        calls[0].reject(Object.assign(new Error("x"), { name })),
      );
      expect(result.current).toMatchObject({ status, promptSlow: false });
      await advance(MIC_PROMPT_SLOW_MS * 2);
      expect(result.current.promptSlow).toBe(false);
    },
  );

  it("clears the note when the mic is switched off while slow", async () => {
    hungGum();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMicPermission(enabled, ""),
      { initialProps: { enabled: true } },
    );
    act(() => result.current.request());
    await advance(MIC_PROMPT_SLOW_MS);
    expect(result.current.promptSlow).toBe(true);
    rerender({ enabled: false });
    expect(result.current).toMatchObject({ status: "idle", promptSlow: false });
  });

  it("leaves no timer behind when it is disabled or unmounted while pending", async () => {
    hungGum();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMicPermission(enabled, ""),
      { initialProps: { enabled: true } },
    );
    act(() => result.current.request());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ enabled: true });
    act(() => result.current.request());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
