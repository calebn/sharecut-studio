import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keeperAudioConstraints } from "./keeper/constraints";
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
