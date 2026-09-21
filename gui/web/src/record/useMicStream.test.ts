import { renderHook, waitFor } from "@testing-library/react";
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
