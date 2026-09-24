import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordSnapshot } from "../../test/fixtures";
import type { RecordSnapshot } from "../types";
import { KeeperSession } from "./session";
import {
  type ByteStream,
  createOpfsSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  OpfsUnavailableError,
} from "./store";
import { useKeeperCapture } from "./useKeeperCapture";

const graphActivity = vi.hoisted(() => vi.fn());
const graphAttach = vi.hoisted(() =>
  vi.fn(
    async (
      _stream: MediaStream,
      onPcm: (pcm: Float32Array, sampleRate: number) => void,
    ) => {
      graphActivity.mockImplementation(() =>
        onPcm(new Float32Array(128), 48_000),
      );
      return () => undefined;
    },
  ),
);

vi.mock("./graph", () => ({
  attachKeeperTap: graphAttach,
}));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

const snap = recordSnapshot({
  session_id: "room1",
  recording_ms: 0,
});

const args = {
  role: "guest" as const,
  snapshot: snap,
  participantId: "p_g",
  muted: false,
  consented: true,
};

describe("useKeeperCapture", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports activity only after the keeper is actively writing", async () => {
    const onActivity = vi.fn();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: RecordSnapshot }) =>
        useKeeperCapture({
          ...args,
          snapshot,
          enabled: true,
          stream,
          onActivity,
        }),
      { initialProps: { snapshot: snap } },
    );
    graphActivity();
    expect(onActivity).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    graphActivity();
    expect(onActivity).toHaveBeenCalledOnce();
    rerender({ snapshot: { ...snap, state: "paused" } });
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(false);
    });
    graphActivity();
    expect(onActivity).toHaveBeenCalledOnce();
  });
  it("does not start a session until enabled", () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: false,
        stream,
      }),
    );
    expect(result.current.recordingLocally).toBe(false);
  });

  it("flags recording locally after the session is writing", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: true,
        stream,
      }),
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    expect(result.current.error).toBeNull();
  });

  it("guards navigation only while the local keeper is writing", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result, unmount } = renderHook(
      ({ enabled, snapshot }: { enabled: boolean; snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled, snapshot, stream }),
      { initialProps: { enabled: true, snapshot: snap } },
    );

    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(true);
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    const event = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);

    rerender({
      enabled: true,
      snapshot: { ...snap, state: "paused" },
    });
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(false);
    });
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(true);

    rerender({ enabled: false, snapshot: snap });
    unmount();
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(true);
  });

  it("keeps the warning until a stopped take finishes saving", async () => {
    const { createOpfsSink, MemorySink } = await import("./store");
    const sink = new MemorySink();
    let releaseClose = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeStarted = false;
    vi.mocked(createOpfsSink).mockResolvedValueOnce({
      write: (path, bytes) => sink.write(path, bytes),
      read: (path) => sink.read(path),
      remove: (path) => sink.remove(path),
      nextSegmentIndex: (sessionId, takeIndex, participantId) =>
        sink.nextSegmentIndex(sessionId, takeIndex, participantId),
      open: async (path) => {
        const stream = await sink.open(path);
        return {
          write: (bytes: Uint8Array, offset?: number) =>
            stream.write(bytes, offset),
          close: async () => {
            closeStarted = true;
            await closeGate;
            await stream.close();
          },
        };
      },
    });
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result } = renderHook(
      ({ enabled, snapshot }: { enabled: boolean; snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled, snapshot, stream }),
      { initialProps: { enabled: true, snapshot: snap } },
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });

    rerender({
      enabled: false,
      snapshot: { ...snap, state: "stopped" },
    });
    await waitFor(() => {
      expect(closeStarted).toBe(true);
      expect(result.current.recordingLocally).toBe(false);
    });
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(false);

    releaseClose();
    await waitFor(() => {
      expect(
        window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
      ).toBe(true);
    });
  });

  it("keeps close protection when the microphone disappears at Stop", async () => {
    const sink = new MemorySink();
    let releaseClose = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeStarted = false;
    vi.mocked(createOpfsSink).mockResolvedValueOnce({
      write: (path, bytes) => sink.write(path, bytes),
      read: (path) => sink.read(path),
      remove: (path) => sink.remove(path),
      nextSegmentIndex: (sessionId, takeIndex, participantId) =>
        sink.nextSegmentIndex(sessionId, takeIndex, participantId),
      open: async (path) => {
        const writable = await sink.open(path);
        return {
          write: (bytes: Uint8Array, offset?: number) =>
            writable.write(bytes, offset),
          close: async () => {
            closeStarted = true;
            await closeGate;
            await writable.close();
          },
        };
      },
    });
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result } = renderHook(
      ({
        snapshot,
        mic,
      }: {
        snapshot: RecordSnapshot;
        mic: MediaStream | null;
      }) => useKeeperCapture({ ...args, enabled: true, snapshot, stream: mic }),
      { initialProps: { snapshot: snap, mic: stream as MediaStream | null } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));

    rerender({ snapshot: { ...snap, state: "stopped" }, mic: null });
    expect(result.current.recordingLocally).toBe(false);
    expect(result.current.finalizing).toBe(true);
    await waitFor(() => expect(closeStarted).toBe(true));
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(false);

    releaseClose();
    await waitFor(() => expect(result.current.finalizing).toBe(false));
  });

  it("removes the warning when active capture unmounts", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, unmount } = renderHook(() =>
      useKeeperCapture({ ...args, enabled: true, stream }),
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    unmount();
    expect(
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ).toBe(true);
  });

  it("does not claim a local copy when OPFS is unavailable", async () => {
    const { createOpfsSink } = await import("./store");
    vi.mocked(createOpfsSink).mockRejectedValueOnce(new OpfsUnavailableError());
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: true,
        stream,
      }),
    );
    await waitFor(() => {
      expect(result.current.error).toMatch(/does not support OPFS/);
    });
    expect(result.current.recordingLocally).toBe(false);

    act(() => result.current.retry());
    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.recordingLocally).toBe(true);
    });
  });

  it("reattaches a failed audio tap when retrying", async () => {
    const { attachKeeperTap } = await import("./graph");
    vi.mocked(attachKeeperTap).mockClear();
    vi.mocked(attachKeeperTap).mockRejectedValueOnce(
      new Error("audio worklet unavailable"),
    );
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({ ...args, enabled: true, stream }),
    );
    await waitFor(() => {
      expect(result.current.error).toMatch(/worklet unavailable/);
      expect(result.current.recordingLocally).toBe(false);
    });

    act(() => result.current.retry());
    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.recordingLocally).toBe(true);
      expect(attachKeeperTap).toHaveBeenCalledTimes(2);
    });
  });

  it("reattaches the audio tap after retrying a failed initial header", async () => {
    const { createOpfsSink } = await import("./store");
    const { attachKeeperTap } = await import("./graph");
    const sink = new MemorySink();
    const open = sink.open.bind(sink);
    let failHeader = true;
    sink.open = async (path): Promise<ByteStream> => {
      const writable = await open(path);
      return {
        write: async (bytes, offset) => {
          if (failHeader) {
            failHeader = false;
            throw new Error("keeper header unavailable");
          }
          await writable.write(bytes, offset);
        },
        close: () => writable.close(),
      };
    };
    vi.mocked(createOpfsSink).mockResolvedValueOnce(sink);
    vi.mocked(attachKeeperTap).mockClear();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({ ...args, enabled: true, stream }),
    );
    await waitFor(() =>
      expect(result.current.error).toMatch(/header unavailable/),
    );
    expect(result.current.recordingLocally).toBe(false);
    expect(attachKeeperTap).not.toHaveBeenCalled();

    act(() => result.current.retry());
    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.recordingLocally).toBe(true);
      expect(attachKeeperTap).toHaveBeenCalledWith(
        stream,
        expect.any(Function),
      );
    });
  });

  it("reports a failed PCM write and stops activity beats", async () => {
    const store = await import("./store");
    const sink = new store.MemorySink();
    const baseOpen = sink.open.bind(sink);
    sink.open = async (path) => {
      const stream = await baseOpen(path);
      return {
        write: async (bytes, offset) => {
          if ((offset ?? 0) >= 44) {
            throw new Error("disk full");
          }
          await stream.write(bytes, offset);
        },
        close: () => stream.close(),
      };
    };
    vi.mocked(store.createOpfsSink).mockResolvedValueOnce(sink);
    const onActivity = vi.fn();
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({ ...args, enabled: true, stream, onActivity }),
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    graphActivity();
    await waitFor(() => expect(result.current.error).toBe("disk full"));
    expect(result.current.recordingLocally).toBe(false);
    graphActivity();
    expect(onActivity).toHaveBeenCalledOnce();
  });

  it("does not error when resetKey remounts during an apply", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result } = renderHook(
      ({ resetKey, muted }: { resetKey: number; muted: boolean }) =>
        useKeeperCapture({
          ...args,
          enabled: true,
          stream,
          resetKey,
          muted,
        }),
      { initialProps: { resetKey: 0, muted: false } },
    );
    await waitFor(() => {
      expect(result.current.recordingLocally).toBe(true);
    });
    rerender({ resetKey: 1, muted: true });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });

  it("does not let an old disposal clear a newer Stop flush", async () => {
    const originalDispose = Reflect.get(
      KeeperSession.prototype,
      "dispose",
    ) as KeeperSession["dispose"];
    const originalApply = Reflect.get(
      KeeperSession.prototype,
      "apply",
    ) as KeeperSession["apply"];
    let releaseOldDispose: (() => void) | undefined;
    let releaseStop: (() => void) | undefined;
    let oldDisposalStarted = false;
    vi.spyOn(KeeperSession.prototype, "dispose").mockImplementation(function (
      this: KeeperSession,
    ) {
      if (oldDisposalStarted) {
        return originalDispose.call(this);
      }
      oldDisposalStarted = true;
      return new Promise<void>((resolve) => {
        releaseOldDispose = () => {
          void originalDispose.call(this).then(resolve);
        };
      });
    });
    vi.spyOn(KeeperSession.prototype, "apply").mockImplementation(function (
      this: KeeperSession,
      gate,
    ) {
      if (gate.roomState !== "stopped") {
        return originalApply.call(this, gate);
      }
      return new Promise<void>((resolve) => {
        releaseStop = () => {
          void originalApply.call(this, gate).then(resolve);
        };
      });
    });
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { rerender, result } = renderHook(
      ({
        resetKey,
        snapshot,
      }: {
        resetKey: number;
        snapshot: RecordSnapshot;
      }) =>
        useKeeperCapture({
          ...args,
          enabled: true,
          stream,
          resetKey,
          snapshot,
        }),
      { initialProps: { resetKey: 0, snapshot: snap } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));

    rerender({ resetKey: 1, snapshot: snap });
    await waitFor(() => expect(oldDisposalStarted).toBe(true));
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    rerender({ resetKey: 1, snapshot: { ...snap, state: "stopped" } });
    await waitFor(() => expect(releaseStop).toBeDefined());
    expect(result.current.finalizing).toBe(true);

    await act(async () => releaseOldDispose?.());
    expect(result.current.finalizing).toBe(true);
    await act(async () => releaseStop?.());
    await waitFor(() => expect(result.current.finalizing).toBe(false));
  });

  it("preserves loss and reconnect gates behind pending storage work", async () => {
    const sink = new MemorySink();
    vi.mocked(createOpfsSink).mockResolvedValueOnce(sink);
    const streamA = { getTracks: () => [] } as unknown as MediaStream;
    const streamB = { getTracks: () => [] } as unknown as MediaStream;
    const applied: Array<{ streamAvailable: boolean; recordingMs: number }> =
      [];
    const originalApply = Reflect.get(
      KeeperSession.prototype,
      "apply",
    ) as KeeperSession["apply"];
    let releasePending: (() => void) | undefined;
    let blockNext = false;
    let now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const apply = vi
      .spyOn(KeeperSession.prototype, "apply")
      .mockImplementation(function (this: KeeperSession, gate) {
        applied.push({
          streamAvailable: gate.streamAvailable,
          recordingMs: gate.recordingMs,
        });
        if (blockNext) {
          blockNext = false;
          return new Promise<void>((resolve) => {
            releasePending = () => {
              void originalApply.call(this, gate).then(resolve);
            };
          });
        }
        return originalApply.call(this, gate);
      });
    try {
      const { rerender, result, unmount } = renderHook(
        ({ stream, muted }: { stream: MediaStream | null; muted: boolean }) =>
          useKeeperCapture({ ...args, enabled: true, stream, muted }),
        {
          initialProps: { stream: streamA as MediaStream | null, muted: false },
        },
      );
      await waitFor(() => expect(result.current.recordingLocally).toBe(true));

      blockNext = true;
      rerender({ stream: streamA, muted: true });
      await waitFor(() => expect(releasePending).toBeDefined());
      now += 5_000;
      rerender({ stream: null, muted: true });
      now += 2_000;
      rerender({ stream: streamB, muted: true });
      await act(async () => releasePending?.());
      await waitFor(() => expect(applied.length).toBeGreaterThanOrEqual(4));

      expect(applied.slice(-3)).toEqual([
        { streamAvailable: true, recordingMs: 0 },
        { streamAvailable: false, recordingMs: 5_000 },
        { streamAvailable: true, recordingMs: 7_000 },
      ]);
      const path = (segmentIndex: number) =>
        keeperWavPath({
          sessionId: snap.session_id,
          takeIndex: 0,
          participantId: "p_g",
          segmentIndex,
        });
      await waitFor(() => expect(sink.files.has(path(1))).toBe(true));
      expect(sink.files.has(keeperMetaPath(path(0)))).toBe(true);
      unmount();
      await waitFor(() =>
        expect(sink.files.has(keeperMetaPath(path(1)))).toBe(true),
      );
      const meta = JSON.parse(
        new TextDecoder().decode(sink.files.get(keeperMetaPath(path(1)))!),
      ) as { joinOffsetMs: number };
      expect(meta.joinOffsetMs).toBe(7_000);
    } finally {
      apply.mockRestore();
      clock.mockRestore();
    }
  });

  it("uses the current recording clock when retrying a failed session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const { createOpfsSink } = await import("./store");
      const sink = new MemorySink();
      const open = sink.open.bind(sink);
      let failHeader = true;
      sink.open = async (path): Promise<ByteStream> => {
        const writable = await open(path);
        return {
          write: async (bytes, offset) => {
            if (failHeader) {
              failHeader = false;
              throw new Error("initial header unavailable");
            }
            await writable.write(bytes, offset);
          },
          close: () => writable.close(),
        };
      };
      vi.mocked(createOpfsSink).mockResolvedValueOnce(sink);
      const stream = { getTracks: () => [] } as unknown as MediaStream;
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useKeeperCapture({
            ...args,
            enabled,
            snapshot: { ...snap, recording_ms: 1_000 },
            stream,
          }),
        { initialProps: { enabled: true } },
      );
      await waitFor(() =>
        expect(result.current.error).toMatch(/initial header unavailable/),
      );

      vi.setSystemTime(3_500);
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.recordingLocally).toBe(true));
      rerender({ enabled: false });
      await waitFor(() =>
        expect(
          [...sink.files.entries()].find(([path]) => path.endsWith(".json")),
        ).toBeDefined(),
      );
      const [, metadata] = [...sink.files.entries()].find(([path]) =>
        path.endsWith(".json"),
      ) ?? ["", new Uint8Array()];
      expect(JSON.parse(new TextDecoder().decode(metadata))).toMatchObject({
        joinOffsetMs: 4_500,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps close risk active until local finalization settles", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(KeeperSession.prototype, "dispose").mockImplementation(
      () => pending,
    );
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useKeeperCapture({ ...args, enabled, stream }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.finalizing).toBe(true));
    expect(result.current.recordingLocally).toBe(false);
    await act(async () => finish?.());
    await waitFor(() => expect(result.current.finalizing).toBe(false));
  });

  it("retains close risk and reports an error when finalization fails", async () => {
    vi.spyOn(KeeperSession.prototype, "dispose").mockRejectedValue(
      new Error("keeper flush failed"),
    );
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useKeeperCapture({ ...args, enabled, stream }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    rerender({ enabled: false });
    await waitFor(() =>
      expect(result.current.error).toBe("keeper flush failed"),
    );
    expect(result.current.finalizing).toBe(true);
  });

  it("does not let a new session retry clear an older failed disposal", async () => {
    vi.spyOn(KeeperSession.prototype, "dispose")
      .mockRejectedValueOnce(new Error("old WAV flush failed"))
      .mockResolvedValue(undefined);
    const newSink = new MemorySink();
    const open = newSink.open.bind(newSink);
    let failClose = true;
    newSink.open = async (path): Promise<ByteStream> => {
      const writable = await open(path);
      return {
        write: (bytes, offset) => writable.write(bytes, offset),
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("new WAV close failed");
          }
          await writable.close();
        },
      };
    };
    vi.mocked(createOpfsSink)
      .mockResolvedValueOnce(new MemorySink())
      .mockResolvedValueOnce(newSink);
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({
        resetKey,
        snapshot,
      }: {
        resetKey: number;
        snapshot: RecordSnapshot;
      }) =>
        useKeeperCapture({
          ...args,
          enabled: true,
          resetKey,
          snapshot,
          stream,
        }),
      { initialProps: { resetKey: 0, snapshot: snap } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    rerender({ resetKey: 1, snapshot: snap });
    await waitFor(() => expect(result.current.finalizing).toBe(true));
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    const nextTake = { ...snap, take_index: 1 };
    rerender({ resetKey: 1, snapshot: nextTake });
    await waitFor(() =>
      expect(result.current.error).toBe("new WAV close failed"),
    );
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    expect(result.current.finalizing).toBe(true);
  });

  it("retains close risk if Stop fails while applying the final keeper gate", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled: true, snapshot, stream }),
      { initialProps: { snapshot: snap } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    vi.spyOn(KeeperSession.prototype, "apply").mockRejectedValueOnce(
      new Error("stop flush failed"),
    );
    rerender({ snapshot: { ...snap, state: "stopped" } });
    await waitFor(() => expect(result.current.error).toBe("stop flush failed"));
    expect(result.current.recordingLocally).toBe(false);
    expect(result.current.finalizing).toBe(true);
  });

  it("retains close risk when the OPFS writable fails to close", async () => {
    const sink = new MemorySink();
    const open = sink.open.bind(sink);
    sink.open = async (path): Promise<ByteStream> => {
      const writable = await open(path);
      return {
        write: (bytes, offset) => writable.write(bytes, offset),
        close: async () => {
          throw new Error("OPFS close failed");
        },
      };
    };
    vi.mocked(createOpfsSink).mockResolvedValueOnce(sink);
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled: true, snapshot, stream }),
      { initialProps: { snapshot: snap } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));

    rerender({ snapshot: { ...snap, state: "stopped" } });
    await waitFor(() => expect(result.current.error).toBe("OPFS close failed"));
    expect(result.current.recordingLocally).toBe(false);
    expect(result.current.finalizing).toBe(true);
  });

  it("clears a recovered finalization failure after retry and Stop", async () => {
    const sink = new MemorySink();
    const open = sink.open.bind(sink);
    let failClose = true;
    sink.open = async (path): Promise<ByteStream> => {
      const writable = await open(path);
      return {
        write: (bytes, offset) => writable.write(bytes, offset),
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("transient OPFS close failure");
          }
          await writable.close();
        },
      };
    };
    vi.mocked(createOpfsSink).mockResolvedValueOnce(sink);
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled: true, snapshot, stream }),
      { initialProps: { snapshot: snap } },
    );
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));

    const nextTake = { ...snap, take_index: 1 };
    rerender({ snapshot: nextTake });
    await waitFor(() =>
      expect(result.current.error).toBe("transient OPFS close failure"),
    );
    expect(result.current.finalizing).toBe(true);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.recordingLocally).toBe(true));
    expect(result.current.finalizing).toBe(false);

    rerender({ snapshot: { ...nextTake, state: "stopped" } });
    await waitFor(() => expect(result.current.recordingLocally).toBe(false));
    expect(result.current.finalizing).toBe(false);
  });
});
