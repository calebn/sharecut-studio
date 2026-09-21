import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecordSnapshot } from "../types";
import { KeeperSession } from "./session";
import {
  createOpfsSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
} from "./store";
import { useKeeperCapture } from "./useKeeperCapture";

vi.mock("./graph", () => ({
  attachKeeperTap: vi.fn(async () => () => undefined),
}));

vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    createOpfsSink: vi.fn(async () => new actual.MemorySink()),
  };
});

const snap: RecordSnapshot = {
  session_id: "room1",
  state: "recording",
  take_index: 0,
  recording_ms: 0,
  participants: [],
  caps: { recorded: 4, producers: 2 },
};

const args = {
  role: "guest" as const,
  snapshot: snap,
  participantId: "p_g",
  muted: false,
  consented: true,
};

describe("useKeeperCapture", () => {
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
    const { rerender, result } = renderHook(
      ({ enabled, snapshot }: { enabled: boolean; snapshot: RecordSnapshot }) =>
        useKeeperCapture({ ...args, enabled, snapshot, stream }),
      { initialProps: { enabled: true, snapshot: snap } },
    );

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
    expect(window.dispatchEvent(new Event("beforeunload"))).toBe(true);

    rerender({ enabled: false, snapshot: snap });
  });

  it("does not claim a local copy when OPFS is unavailable", async () => {
    const { createOpfsSink } = await import("./store");
    vi.mocked(createOpfsSink).mockRejectedValueOnce(
      new Error(
        "This browser cannot store a local keeper copy (OPFS unavailable).",
      ),
    );
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const { result } = renderHook(() =>
      useKeeperCapture({
        ...args,
        enabled: true,
        stream,
      }),
    );
    await waitFor(() => {
      expect(result.current.error).toMatch(/OPFS unavailable/);
    });
    expect(result.current.recordingLocally).toBe(false);
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
});
