import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySink } from "./keeper/store";
import { ROOM_TONE_DURATION_SEC, ROOM_TONE_MIN_SEC } from "./types";
import { memoryUploadTransport } from "./upload/transport";
import { useRoomToneCapture } from "./useRoomToneCapture";

const encode = vi.fn();

vi.mock("./encodeRoomTone", () => ({
  encodeRoomToneWav: (...args: unknown[]) => encode(...args),
}));

function hookArgs(
  overrides: Partial<Parameters<typeof useRoomToneCapture>[0]> = {},
) {
  return {
    enabled: true,
    canUpload: true,
    stream: {} as MediaStream,
    sessionId: "room1",
    participantId: "p_a",
    sink: new MemorySink(),
    transport: memoryUploadTransport(),
    ...overrides,
  };
}

describe("useRoomToneCapture", () => {
  beforeEach(() => {
    encode.mockReset();
    encode.mockResolvedValue({
      wav: new Uint8Array(44 + 8),
      samples: new Float32Array(4).fill(0.001),
      durationSec: ROOM_TONE_DURATION_SEC,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips without capturing", () => {
    const { result } = renderHook(() => useRoomToneCapture(hookArgs()));
    act(() => {
      result.current.skip();
    });
    expect(result.current.status).toBe("skipped");
    expect(result.current.ready).toBe(true);
    expect(encode).not.toHaveBeenCalled();
  });

  it("producers never enable capture", () => {
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ enabled: false })),
    );
    act(() => {
      result.current.record();
    });
    expect(encode).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("writes OPFS and uploads a quiet bed when canUpload", async () => {
    const sink = new MemorySink();
    const transport = memoryUploadTransport();
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ sink, transport })),
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("recorded");
    });
    expect(result.current.ready).toBe(true);
    expect(
      await sink.read("Sharecut Recordings/room1/room-tone/p_a.wav"),
    ).toEqual(new Uint8Array(44 + 8));
    expect(transport.puts).toBe(1);
    expect(result.current.delivery).toBe("host");
  });

  it("keeps saying the bed is on this device until the host acknowledges the file", async () => {
    const sink = new MemorySink();
    const base = memoryUploadTransport();
    const transport = {
      ...base,
      put: async (...a: Parameters<typeof base.put>) => ({
        ...(await base.put(...a)),
        file_ack: false,
      }),
    };
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ sink, transport })),
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("recorded");
    });
    expect(result.current.delivery).toBe("device");
  });

  it("goes back to this device when the bed is recorded again", async () => {
    const sink = new MemorySink();
    const transport = memoryUploadTransport();
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ sink, transport })),
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.delivery).toBe("host");
    });
    act(() => {
      result.current.record();
    });
    expect(result.current.delivery).toBe("device");
    await waitFor(() => {
      expect(result.current.delivery).toBe("host");
    });
  });

  it("defers upload until canUpload becomes true", async () => {
    const sink = new MemorySink();
    const transport = memoryUploadTransport();
    const { result, rerender } = renderHook(
      (props: { canUpload: boolean }) =>
        useRoomToneCapture(
          hookArgs({ sink, transport, canUpload: props.canUpload }),
        ),
      { initialProps: { canUpload: false } },
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("recorded");
    });
    expect(transport.puts).toBe(0);
    expect(result.current.delivery).toBe("device");
    rerender({ canUpload: true });
    await waitFor(() => {
      expect(transport.puts).toBe(1);
    });
    await waitFor(() => {
      expect(result.current.delivery).toBe("host");
    });
  });

  it("does not upload a too-loud bed", async () => {
    encode.mockResolvedValue({
      wav: new Uint8Array(44 + 8),
      samples: new Float32Array(4).fill(1),
    });
    const sink = new MemorySink();
    const transport = memoryUploadTransport();
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ sink, transport })),
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("too_loud");
    });
    expect(result.current.ready).toBe(true);
    expect(transport.puts).toBe(0);
    expect(
      await sink.read("Sharecut Recordings/room1/room-tone/p_a.wav"),
    ).toBeNull();
  });

  it("still revokes the remote bed when the local delete throws on skip", async () => {
    const sink = new MemorySink();
    vi.spyOn(sink, "remove").mockRejectedValue(
      new DOMException("locked", "NoModificationAllowedError"),
    );
    const transport = memoryUploadTransport();
    const revokeRoomTone = vi.fn(async () => undefined);
    transport.revokeRoomTone = revokeRoomTone;
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ sink, transport })),
    );
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("recorded");
    });
    act(() => {
      result.current.skip();
    });
    await waitFor(() => expect(revokeRoomTone).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("skipped");
    expect(result.current.error).toBeNull();
  });

  it("reports too_loud even when deleting the loud bed throws", async () => {
    encode.mockResolvedValue({
      wav: new Uint8Array(44 + 8),
      samples: new Float32Array(4).fill(1),
    });
    const sink = new MemorySink();
    vi.spyOn(sink, "remove").mockRejectedValue(
      new DOMException("stale", "InvalidStateError"),
    );
    const { result } = renderHook(() => useRoomToneCapture(hookArgs({ sink })));
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("too_loud");
    });
    expect(result.current.error).toBeNull();
  });

  it("swallows a throwing delete when capture is disabled", async () => {
    const sink = new MemorySink();
    const remove = vi
      .spyOn(sink, "remove")
      .mockRejectedValue(
        new DOMException("locked", "NoModificationAllowedError"),
      );
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useRoomToneCapture(hookArgs({ sink, enabled: props.enabled })),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    await waitFor(() => expect(remove).toHaveBeenCalled());
  });

  it("surfaces an error when the hook is not ready", () => {
    const { result } = renderHook(() =>
      useRoomToneCapture(
        hookArgs({
          sink: null,
          sessionId: null,
        }),
      ),
    );
    act(() => {
      result.current.record();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/not ready/);
    expect(encode).not.toHaveBeenCalled();
  });

  it("only the latest capture clears inflight after skip", async () => {
    let releaseFirst: (() => void) | undefined;
    encode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              wav: new Uint8Array(44 + 8),
              samples: new Float32Array(4).fill(0.001),
            });
        }),
    );
    encode.mockResolvedValue({
      wav: new Uint8Array(44 + 8),
      samples: new Float32Array(4).fill(0.001),
    });
    const transport = memoryUploadTransport();
    const { result } = renderHook(() =>
      useRoomToneCapture(hookArgs({ transport })),
    );
    act(() => {
      result.current.record();
    });
    act(() => {
      result.current.skip();
    });
    expect(result.current.status).toBe("skipped");
    await act(async () => {
      releaseFirst?.();
    });
    act(() => {
      result.current.record();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("recorded");
    });
    expect(transport.puts).toBe(1);
  });

  it("cancels a capture in flight when it is disabled, such as a take starting", async () => {
    encode.mockImplementationOnce(
      (_stream: MediaStream, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useRoomToneCapture(hookArgs({ enabled: props.enabled })),
      { initialProps: { enabled: true } },
    );
    act(() => {
      result.current.record();
    });
    expect(result.current.status).toBe("capturing");
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.error).toBeNull();
  });

  describe("the one-minute take", () => {
    type EncodeOptions = { signal: AbortSignal; stopSignal: AbortSignal };

    /** A take that runs until stopped, then keeps `keptSec` of audio. */
    function takeStoppedAt(keptSec: number) {
      encode.mockImplementationOnce(
        (_stream: MediaStream, { signal, stopSignal }: EncodeOptions) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
            stopSignal.addEventListener("abort", () =>
              resolve({
                wav: new Uint8Array(44 + 8),
                samples: new Float32Array(4).fill(0.001),
                durationSec: keptSec,
              }),
            );
          }),
      );
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts the minute down a second at a time", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      takeStoppedAt(ROOM_TONE_DURATION_SEC);
      const { result } = renderHook(() => useRoomToneCapture(hookArgs()));
      expect(result.current.clock.remainingSec).toBe(ROOM_TONE_DURATION_SEC);
      act(() => {
        result.current.record();
      });
      expect(result.current.clock).toEqual({ remainingSec: 60, progress: 0 });
      act(() => {
        vi.advanceTimersByTime(18_000);
      });
      expect(result.current.clock.remainingSec).toBe(42);
      expect(result.current.clock.progress).toBeCloseTo(0.3);
      act(() => {
        vi.advanceTimersByTime(42_000);
      });
      expect(result.current.clock.remainingSec).toBe(0);
      expect(result.current.clock.progress).toBe(1);
    });

    it("keeps a take ended early once it is long enough", async () => {
      const sink = new MemorySink();
      const transport = memoryUploadTransport();
      takeStoppedAt(ROOM_TONE_MIN_SEC);
      const { result } = renderHook(() =>
        useRoomToneCapture(hookArgs({ sink, transport })),
      );
      act(() => {
        result.current.record();
      });
      act(() => {
        result.current.endEarly();
      });
      await waitFor(() => expect(result.current.status).toBe("recorded"));
      expect(transport.puts).toBe(1);
      expect(
        await sink.read("Sharecut Recordings/room1/room-tone/p_a.wav"),
      ).toEqual(new Uint8Array(44 + 8));
    });

    it("discards a take ended before the minimum and writes and sends nothing", async () => {
      const sink = new MemorySink();
      const transport = memoryUploadTransport();
      takeStoppedAt(ROOM_TONE_MIN_SEC - 0.5);
      const { result } = renderHook(() =>
        useRoomToneCapture(hookArgs({ sink, transport })),
      );
      act(() => {
        result.current.record();
      });
      act(() => {
        result.current.endEarly();
      });
      await waitFor(() => expect(result.current.status).toBe("too_short"));
      expect(result.current.ready).toBe(true);
      expect(transport.puts).toBe(0);
      expect(
        await sink.read("Sharecut Recordings/room1/room-tone/p_a.wav"),
      ).toBeNull();
    });

    it("cancels back to idle, drops the take and lets a new one start", async () => {
      const transport = memoryUploadTransport();
      takeStoppedAt(ROOM_TONE_DURATION_SEC);
      const { result } = renderHook(() =>
        useRoomToneCapture(hookArgs({ transport })),
      );
      act(() => {
        result.current.record();
      });
      expect(result.current.status).toBe("capturing");
      act(() => {
        result.current.cancel();
      });
      expect(result.current.status).toBe("idle");
      expect(result.current.ready).toBe(false);
      expect(transport.puts).toBe(0);
      act(() => {
        result.current.record();
      });
      await waitFor(() => expect(result.current.status).toBe("recorded"));
    });

    it("ignores Cancel once nothing is capturing", async () => {
      const { result } = renderHook(() => useRoomToneCapture(hookArgs()));
      act(() => {
        result.current.record();
      });
      await waitFor(() => expect(result.current.status).toBe("recorded"));
      act(() => {
        result.current.cancel();
      });
      expect(result.current.status).toBe("recorded");
    });
  });
});
