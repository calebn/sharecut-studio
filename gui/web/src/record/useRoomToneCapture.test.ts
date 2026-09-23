import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySink } from "./keeper/store";
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
    rerender({ canUpload: true });
    await waitFor(() => {
      expect(transport.puts).toBe(1);
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
});
