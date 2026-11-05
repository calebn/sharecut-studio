import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { keeperAudioConstraints } from "./keeper/constraints";
import { useMicStream } from "./useMicStream";

describe("useMicStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the dry keeper constraints", async () => {
    const track = {
      stop: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const gum = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    }));
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => {
      expect(result.current.stream).not.toBeNull();
    });
    expect(gum).toHaveBeenCalledWith(keeperAudioConstraints(""));
  });

  it("re-requests the mic when resetKey changes", async () => {
    const track = {
      stop: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const gum = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    }));
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { rerender } = renderHook(
      ({ resetKey }: { resetKey: number }) => useMicStream(true, "", resetKey),
      { initialProps: { resetKey: 0 } },
    );
    await waitFor(() => {
      expect(gum).toHaveBeenCalledTimes(1);
    });
    rerender({ resetKey: 1 });
    await waitFor(() => {
      expect(gum).toHaveBeenCalledTimes(2);
    });
  });

  it("does not call getUserMedia when disabled", () => {
    const gum = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: gum, enumerateDevices: vi.fn() },
    });
    renderHook(() => useMicStream(false, ""));
    expect(gum).not.toHaveBeenCalled();
  });

  it("reacquires a live stream after an initial permission denial", async () => {
    const track = {
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const gum = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { name: "NotAllowedError" }),
      )
      .mockResolvedValueOnce({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() =>
      expect(result.current.errorName).toBe("NotAllowedError"),
    );
    expect(result.current.stream).toBeNull();
    result.current.retry();
    await waitFor(() => expect(result.current.stream).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it("marks an active track loss and retries without reacting to stale tracks", async () => {
    let ended: (() => void) | undefined;
    const firstTrack = {
      readyState: "live",
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
    };
    const secondTrack = {
      ...firstTrack,
      addEventListener: vi.fn(),
    };
    const gum = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [firstTrack],
        getAudioTracks: () => [firstTrack],
      })
      .mockResolvedValueOnce({
        getTracks: () => [secondTrack],
        getAudioTracks: () => [secondTrack],
      });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    ended?.();
    await waitFor(() => expect(result.current.lost).toBe(true));
    expect(result.current.stream).toBeNull();
    result.current.retry();
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.lost).toBe(false));
    ended?.();
    expect(result.current.stream).not.toBeNull();
  });

  it("keeps the loss state when an explicit reconnect fails", async () => {
    let ended: (() => void) | undefined;
    const track = {
      readyState: "live",
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
    };
    const gum = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })
      .mockRejectedValueOnce(new Error("device still unavailable"));
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    ended?.();
    await waitFor(() => expect(result.current.lost).toBe(true));
    result.current.retry();
    await waitFor(() => expect(result.current.error).toMatch(/unavailable/));
    expect(result.current.lost).toBe(true);
    expect(result.current.stream).toBeNull();
  });

  it("falls back to the default input when a saved device id is stale", async () => {
    const track = {
      stop: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const stale = new Error("no such device");
    stale.name = "OverconstrainedError";
    const gum = vi
      .fn()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, "dead-id"));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    expect(gum).toHaveBeenNthCalledWith(1, keeperAudioConstraints("dead-id"));
    expect(gum).toHaveBeenNthCalledWith(2, keeperAudioConstraints());
    expect(result.current.staleDeviceId).toBe("dead-id");
    expect(result.current.error).toBeNull();
  });

  describe("after a stale saved id fell back", () => {
    const makeStream = () => {
      const track = {
        stop: vi.fn(),
        getSettings: () => ({
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        }),
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    };
    const staleError = () => {
      const stale = new Error("no such device");
      stale.name = "OverconstrainedError";
      return stale;
    };

    it("retries straight on the default input", async () => {
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream())
        .mockResolvedValueOnce(makeStream());
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => [
            { kind: "audioinput", deviceId: "builtin", label: "Built-in" },
          ]),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      act(() => result.current.retry());
      await waitFor(() => expect(gum).toHaveBeenCalledTimes(3));
      expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints());
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      expect(result.current.staleDeviceId).toBe("dead-id");
    });

    it("keeps the fallback when a later Retry fails", async () => {
      const denied = new Error("blocked");
      denied.name = "NotAllowedError";
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream())
        .mockRejectedValueOnce(denied);
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => [
            { kind: "audioinput", deviceId: "builtin", label: "Built-in" },
          ]),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      act(() => result.current.retry());
      await waitFor(() =>
        expect(result.current.errorName).toBe("NotAllowedError"),
      );
      expect(result.current.staleDeviceId).toBe("dead-id");
    });

    it("tries the saved id again once it is listed", async () => {
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream())
        .mockResolvedValueOnce(makeStream());
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => [
            { kind: "audioinput", deviceId: "dead-id", label: "USB" },
          ]),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.devices).toHaveLength(1));
      act(() => result.current.retry());
      await waitFor(() => expect(gum).toHaveBeenCalledTimes(3));
      expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints("dead-id"));
      await waitFor(() => expect(result.current.staleDeviceId).toBeNull());
    });

    it("keeps the latch while the mic is disabled", async () => {
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream());
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => [
            { kind: "audioinput", deviceId: "builtin", label: "Built-in" },
          ]),
        },
      });
      const { result, rerender } = renderHook(
        ({ on }: { on: boolean }) => useMicStream(on, "dead-id"),
        { initialProps: { on: true } },
      );
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      rerender({ on: false });
      await waitFor(() => expect(result.current.stream).toBeNull());
      expect(result.current.staleDeviceId).toBe("dead-id");
    });

    it("tries the saved id when enumeration fails", async () => {
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream())
        .mockResolvedValueOnce(makeStream());
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn().mockRejectedValue(new Error("no list")),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      act(() => result.current.retry());
      await waitFor(() => expect(gum).toHaveBeenCalledTimes(3));
      expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints("dead-id"));
      await waitFor(() => expect(result.current.staleDeviceId).toBeNull());
    });

    it("re-enumerates before skipping the saved id", async () => {
      const builtin = {
        kind: "audioinput",
        deviceId: "builtin",
        label: "Built-in",
      };
      const usb = { kind: "audioinput", deviceId: "dead-id", label: "USB" };
      const gum = vi
        .fn()
        .mockRejectedValueOnce(staleError())
        .mockResolvedValueOnce(makeStream())
        .mockResolvedValueOnce(makeStream());
      const enumerateDevices = vi
        .fn()
        .mockResolvedValueOnce([builtin])
        .mockResolvedValue([builtin, usb]);
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: gum, enumerateDevices },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.devices).toHaveLength(1));
      act(() => result.current.retry());
      await waitFor(() => expect(gum).toHaveBeenCalledTimes(3));
      expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints("dead-id"));
    });
  });

  it("does not fall back when the microphone is blocked", async () => {
    const denied = new Error("blocked");
    denied.name = "NotAllowedError";
    const gum = vi.fn().mockRejectedValue(denied);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, "dead-id"));
    await waitFor(() =>
      expect(result.current.errorName).toBe("NotAllowedError"),
    );
    expect(gum).toHaveBeenCalledTimes(1);
    expect(result.current.staleDeviceId).toBeNull();
  });

  it("falls back to the default input once when a lost selected mic is unavailable", async () => {
    let ended: (() => void) | undefined;
    const makeTrack = () => ({
      readyState: "live",
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
    const unavailable = new Error("Selected mic was unplugged");
    unavailable.name = "NotFoundError";
    const gum = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [makeTrack()],
        getAudioTracks: () => [makeTrack()],
      })
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        getTracks: () => [makeTrack()],
        getAudioTracks: () => [makeTrack()],
      });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, "usb-mic"));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    ended?.();
    await waitFor(() => expect(result.current.lost).toBe(true));
    result.current.retry();
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    expect(gum).toHaveBeenNthCalledWith(2, keeperAudioConstraints("usb-mic"));
    expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints());
    expect(result.current.lost).toBe(false);
    expect(result.current.staleDeviceId).toBe("usb-mic");
  });

  it("ignores repeated lost-state retries while reconnecting", async () => {
    let ended: (() => void) | undefined;
    let resolveReconnect:
      | ((value: {
          getTracks: () => ReturnType<typeof makeTrack>[];
          getAudioTracks: () => ReturnType<typeof makeTrack>[];
        }) => void)
      | undefined;
    const makeTrack = () => ({
      readyState: "live",
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
    const firstTrack = makeTrack();
    const gum = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [firstTrack],
        getAudioTracks: () => [firstTrack],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReconnect = resolve;
          }),
      );
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    ended?.();
    await waitFor(() => expect(result.current.lost).toBe(true));
    result.current.retry();
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(2));
    result.current.retry();
    result.current.retry();
    expect(gum).toHaveBeenCalledTimes(2);
    const replacement = makeTrack();
    resolveReconnect?.({
      getTracks: () => [replacement],
      getAudioTracks: () => [replacement],
    });
    await waitFor(() => expect(result.current.lost).toBe(false));
  });

  it("refreshes input devices without treating every devicechange as a loss", async () => {
    let onDeviceChange: (() => void) | undefined;
    const track = {
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const mediaDevices = {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
      enumerateDevices: vi.fn(async () => [
        { kind: "audioinput", deviceId: "new-device" },
      ]),
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        onDeviceChange = listener;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { mediaDevices });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    onDeviceChange?.();
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.lost).toBe(false);
  });

  it("keeps the newest device list when devicechange refreshes resolve out of order", async () => {
    let onDeviceChange: (() => void) | undefined;
    let resolveOlder: ((value: MediaDeviceInfo[]) => void) | undefined;
    let resolveNewer: ((value: MediaDeviceInfo[]) => void) | undefined;
    let enumerateCalls = 0;
    const track = {
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        })),
        enumerateDevices: vi.fn(() => {
          enumerateCalls += 1;
          if (enumerateCalls === 1) {
            return Promise.resolve([]);
          }
          return new Promise<MediaDeviceInfo[]>((resolve) => {
            if (enumerateCalls === 2) {
              resolveOlder = resolve;
            } else {
              resolveNewer = resolve;
            }
          });
        }),
        addEventListener: vi.fn((_type: string, listener: () => void) => {
          onDeviceChange = listener;
        }),
        removeEventListener: vi.fn(),
      },
    });
    const { result } = renderHook(() => useMicStream(true, ""));
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    onDeviceChange?.();
    onDeviceChange?.();
    resolveNewer?.([
      { kind: "audioinput", deviceId: "newest" } as MediaDeviceInfo,
    ]);
    await waitFor(() =>
      expect(result.current.devices[0]?.deviceId).toBe("newest"),
    );
    resolveOlder?.([
      { kind: "audioinput", deviceId: "older" } as MediaDeviceInfo,
    ]);
    await waitFor(() =>
      expect(result.current.devices[0]?.deviceId).toBe("newest"),
    );
  });

  it("removes listeners before an intentional stop", async () => {
    let ended: (() => void) | undefined;
    const track = {
      readyState: "live",
      stop: vi.fn(() => ended?.()),
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        ended = listener;
      }),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const mediaDevices = {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { mediaDevices });
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicStream(enabled, ""),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.stream).toBeTruthy());
    rerender({ enabled: false });
    expect(track.removeEventListener).toHaveBeenCalledWith("ended", ended);
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(result.current.lost).toBe(false);
  });
});

describe("microphone acquisition ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  function microphone() {
    const track = {
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    return { track, stream };
  }

  it("settles disable while retiring a late stream before re-enable", async () => {
    const first = deferred<MediaStream>();
    const next = deferred<MediaStream>();
    const old = microphone();
    const current = microphone();
    const gum = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(next.promise);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result, rerender } = renderHook(
      ({ enabled, resetKey }) => useMicStream(enabled, "usb", resetKey),
      { initialProps: { enabled: true, resetKey: 3 } },
    );
    expect(result.current.pending).toBe(true);
    rerender({ enabled: false, resetKey: 4 });
    expect(result.current).toMatchObject({
      stream: null,
      pending: false,
      error: null,
      errorName: null,
      settingsWarning: null,
      lost: false,
      settledAttempt: 4,
    });
    await act(async () => first.resolve(old.stream));
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(gum).toHaveBeenCalledOnce();
    rerender({ enabled: true, resetKey: 4 });
    expect(result.current.pending).toBe(true);
    expect(result.current.settledAttempt).toBe(4);
    await act(async () => next.resolve(current.stream));
    expect(result.current.stream).toBe(current.stream);
    expect(result.current.pending).toBe(false);
    expect(current.track.stop).not.toHaveBeenCalled();
  });

  it("keeps the current stream and device history after a retired request rejects", async () => {
    const old = deferred<MediaStream>();
    const current = microphone();
    const devices = [
      { deviceId: "usb", kind: "audioinput", label: "USB", groupId: "g" },
    ] as MediaDeviceInfo[];
    const gum = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(current.stream);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => devices),
      },
    });
    const { result, rerender } = renderHook(
      ({ deviceId, resetKey }) => useMicStream(true, deviceId, resetKey),
      { initialProps: { deviceId: "old", resetKey: 1 } },
    );
    rerender({ deviceId: "usb", resetKey: 2 });
    await waitFor(() => expect(result.current.stream).toBe(current.stream));
    await waitFor(() => expect(result.current.devices).toEqual(devices));
    await act(async () =>
      old.reject(
        Object.assign(new Error("old denial"), { name: "NotAllowedError" }),
      ),
    );
    expect(result.current).toMatchObject({
      stream: current.stream,
      pending: false,
      error: null,
      errorName: null,
      lost: false,
      settledAttempt: 2,
    });
    expect(result.current.devices).toEqual(devices);
    expect(current.track.stop).not.toHaveBeenCalled();
  });

  it("balances replay acquisitions and stops only each acquired stream", async () => {
    const first = deferred<MediaStream>();
    const next = deferred<MediaStream>();
    const old = microphone();
    const current = microphone();
    const gum = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(next.promise);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result, unmount } = renderHook(() => useMicStream(true, ""), {
      wrapper: StrictMode,
    });
    expect(gum).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(current.stream));
    expect(result.current.stream).toBe(current.stream);
    await act(async () => first.resolve(old.stream));
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(current.track.stop).not.toHaveBeenCalled();
    unmount();
    expect(current.track.stop).toHaveBeenCalledOnce();
    expect(old.track.stop).toHaveBeenCalledOnce();
  });

  it("preserves the enabled value captured by retained retry callbacks", async () => {
    const current = microphone();
    const gum = vi.fn(async () => current.stream);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicStream(enabled, ""),
      { initialProps: { enabled: false } },
    );
    const disabledRetry = result.current.retry;
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.stream).toBe(current.stream));
    act(() => disabledRetry());
    expect(gum).toHaveBeenCalledOnce();
    const enabledRetry = result.current.retry;
    rerender({ enabled: false });
    act(() => enabledRetry());
    expect(gum).toHaveBeenCalledOnce();
    expect(result.current.pending).toBe(false);
    expect(result.current.stream).toBeNull();
    rerender({ enabled: true });
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(2));
  });

  it("retains warning and settled attempt until a replacement settles", async () => {
    const first = microphone();
    first.track.getSettings = () => ({
      echoCancellation: true,
      autoGainControl: false,
      noiseSuppression: false,
    });
    const next = deferred<MediaStream>();
    const gum = vi
      .fn()
      .mockResolvedValueOnce(first.stream)
      .mockReturnValueOnce(next.promise);
    const devices = [
      { deviceId: "old", kind: "audioinput", label: "Old", groupId: "g" },
    ] as MediaDeviceInfo[];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => devices),
      },
    });
    const { result, rerender } = renderHook(
      ({ deviceId, resetKey }) => useMicStream(true, deviceId, resetKey),
      { initialProps: { deviceId: "old", resetKey: 2 } },
    );
    await waitFor(() => expect(result.current.stream).toBe(first.stream));
    await waitFor(() => expect(result.current.devices).toEqual(devices));
    const warning = result.current.settingsWarning;
    expect(warning).not.toBeNull();
    rerender({ deviceId: "next", resetKey: 3 });
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({
      stream: null,
      pending: true,
      settingsWarning: warning,
      settledAttempt: 2,
    });
    expect(result.current.devices).toEqual(devices);
    const current = microphone();
    await act(async () => next.resolve(current.stream));
    expect(result.current).toMatchObject({
      stream: current.stream,
      pending: false,
      settingsWarning: null,
      settledAttempt: 3,
    });
  });

  it.each(["device", "reset", "disable"] as const)(
    "publishes %s stream retirement to borrowers at actual passive cleanup",
    async (transition) => {
      const first = microphone();
      const next = deferred<MediaStream>();
      const gum = vi
        .fn()
        .mockResolvedValueOnce(first.stream)
        .mockReturnValueOnce(next.promise);
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => []),
        },
      });
      const observations: {
        deviceId: string;
        stream: MediaStream | null;
        stops: number;
      }[] = [];
      const { result, rerender } = renderHook(
        ({ deviceId, enabled, resetKey }) => {
          const value = useMicStream(enabled, deviceId, resetKey);
          useLayoutEffect(() => {
            observations.push({
              deviceId,
              stream: value.stream,
              stops: first.track.stop.mock.calls.length,
            });
          });
          return value;
        },
        { initialProps: { deviceId: "first", enabled: true, resetKey: 0 } },
      );
      await waitFor(() => expect(result.current.stream).toBe(first.stream));
      observations.length = 0;
      const deviceId = transition === "device" ? "next" : "first";
      rerender({
        deviceId,
        enabled: transition !== "disable",
        resetKey: transition === "reset" ? 1 : 0,
      });
      expect(observations[0]).toEqual({
        deviceId,
        stream: first.stream,
        stops: 0,
      });
      expect(observations.at(-1)).toEqual({ deviceId, stream: null, stops: 1 });
      if (transition !== "disable") {
        const current = microphone();
        await act(async () => next.resolve(current.stream));
        expect(result.current.stream).toBe(current.stream);
      } else expect(gum).toHaveBeenCalledOnce();
    },
  );

  it("keeps the replacement acquisition locked when a retired request settles", async () => {
    const old = deferred<MediaStream>();
    const next = deferred<MediaStream>();
    const current = microphone();
    const gum = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result, rerender } = renderHook(
      ({ deviceId }) => useMicStream(true, deviceId),
      { initialProps: { deviceId: "old" } },
    );
    rerender({ deviceId: "next" });
    await act(async () => old.reject(new Error("retired")));
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    expect(gum).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(true);
    await act(async () => next.resolve(current.stream));
    expect(result.current.stream).toBe(current.stream);
    expect(result.current.error).toBeNull();
  });

  it("does not report an already-ended acquisition as a settled success", async () => {
    const ended = microphone();
    ended.track.readyState = "ended";
    const current = microphone();
    const gum = vi
      .fn()
      .mockResolvedValueOnce(ended.stream)
      .mockResolvedValueOnce(current.stream);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result } = renderHook(() => useMicStream(true, "", 5));
    await waitFor(() => expect(result.current.lost).toBe(true));
    expect(result.current).toMatchObject({
      stream: null,
      pending: false,
      settledAttempt: 0,
    });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.stream).toBe(current.stream));
    expect(result.current.settledAttempt).toBe(5);
    expect(ended.track.stop).toHaveBeenCalledOnce();
  });

  it("retains a fallback latch through a failed different device and treats empty enumeration as unknown", async () => {
    const fallback = microphone();
    const restored = microphone();
    const gum = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { name: "OverconstrainedError" }),
      )
      .mockResolvedValueOnce(fallback.stream)
      .mockRejectedValueOnce(
        Object.assign(new Error("blocked B"), { name: "NotAllowedError" }),
      )
      .mockResolvedValueOnce(restored.stream);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: gum,
        enumerateDevices: vi.fn(async () => []),
      },
    });
    const { result, rerender } = renderHook(
      ({ deviceId }) => useMicStream(true, deviceId),
      { initialProps: { deviceId: "A" } },
    );
    await waitFor(() => expect(result.current.staleDeviceId).toBe("A"));
    rerender({ deviceId: "B" });
    await waitFor(() => expect(result.current.error).toBe("blocked B"));
    expect(result.current.staleDeviceId).toBeNull();
    rerender({ deviceId: "A" });
    expect(result.current.staleDeviceId).toBe("A");
    await waitFor(() => expect(result.current.stream).toBe(restored.stream));
    expect(gum).toHaveBeenNthCalledWith(4, keeperAudioConstraints("A"));
    expect(result.current.staleDeviceId).toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an old request %s queued from replacement layout",
    async (settlement) => {
      const old = deferred<MediaStream>();
      const next = deferred<MediaStream>();
      const retired = microphone();
      const current = microphone();
      const gum = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: gum,
          enumerateDevices: vi.fn(async () => []),
        },
      });
      const { result, rerender } = renderHook(
        ({ deviceId }) => {
          const value = useMicStream(true, deviceId);
          useLayoutEffect(() => {
            if (deviceId !== "next") return;
            if (settlement === "resolve") old.resolve(retired.stream);
            else old.reject(new Error("retired during layout"));
          }, [deviceId]);
          return value;
        },
        { initialProps: { deviceId: "old" } },
      );
      await act(async () => rerender({ deviceId: "next" }));
      expect(result.current).toMatchObject({
        stream: null,
        pending: true,
        error: null,
        errorName: null,
      });
      expect(retired.track.stop).toHaveBeenCalledTimes(
        settlement === "resolve" ? 1 : 0,
      );
      await act(async () => next.resolve(current.stream));
      expect(result.current.stream).toBe(current.stream);
      expect(current.track.stop).not.toHaveBeenCalled();
    },
  );
});
