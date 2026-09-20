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
});
