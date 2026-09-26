import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(result.current.fellBackFrom).toBe("dead-id");
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
          enumerateDevices: vi.fn(async () => []),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      act(() => result.current.retry());
      await waitFor(() => expect(gum).toHaveBeenCalledTimes(3));
      expect(gum).toHaveBeenNthCalledWith(3, keeperAudioConstraints());
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      expect(result.current.fellBackFrom).toBe("dead-id");
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
          enumerateDevices: vi.fn(async () => []),
        },
      });
      const { result } = renderHook(() => useMicStream(true, "dead-id"));
      await waitFor(() => expect(result.current.stream).toBeTruthy());
      act(() => result.current.retry());
      await waitFor(() =>
        expect(result.current.errorName).toBe("NotAllowedError"),
      );
      expect(result.current.fellBackFrom).toBe("dead-id");
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
      await waitFor(() => expect(result.current.fellBackFrom).toBeNull());
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
    expect(result.current.fellBackFrom).toBeNull();
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
    expect(result.current.fellBackFrom).toBe("usb-mic");
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
