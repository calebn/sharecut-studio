import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import {
  pollSnapshotAlreadyApplied,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { documentClientId } from "../utils/documentClient";
import { useDocumentSync } from "./useDocumentSync";

vi.mock("../state/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
}));

const track = (id: string, label = id): TrackView => ({
  id,
  label,
  role: "dialogue",
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 1,
  fx_count: 0,
  stem_is_fresh: true,
});

describe("useDocumentSync", () => {
  beforeEach(() => {
    FakeWebSocket.reset({ autoOpen: false });
    resetDocumentSeqForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges patch.tracks, ignores non-document frames, and keeps comments-only merges", async () => {
    renderHook(() => useDocumentSync("/tmp/ep.json", () => undefined, true));
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 2,
        snapshot: {
          server_seq: 2,
          patch: { tracks: [track("b"), track("a")] },
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
    const tracksAfterPatch = useDawStore.getState().project?.tracks;

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Ping",
        server_seq: 2,
        snapshot: { server_seq: 2, project: minimalProject() },
      });
    });
    expect(useDawStore.getState().project?.tracks).toBe(tracksAfterPatch);

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 3,
        snapshot: {
          server_seq: 3,
          comments: [{ id: "c1", body: "note" }],
        },
      });
    });
    expect(useDawStore.getState().project?.comments).toEqual([
      { id: "c1", body: "note" },
    ]);
    expect(useDawStore.getState().project?.tracks).toBe(tracksAfterPatch);
  });

  it("ignores a non-document frame and still applies a later same-seq Applied", async () => {
    renderHook(() => useDocumentSync("/tmp/ep.json", () => undefined, true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Ping",
        server_seq: 4,
        snapshot: {
          server_seq: 4,
          project: minimalProject({ tracks: [track("echo")] }),
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).not.toEqual(
      ["echo"],
    );

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 4,
        snapshot: {
          server_seq: 4,
          patch: { tracks: [track("real")] },
        },
      });
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "real",
    ]);
  });

  it("reconnects after a non-4403 close", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useDocumentSync("/tmp/ep.json", () => undefined, true),
    );
    try {
      await act(async () => {
        FakeWebSocket.instances[0].close(1011);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("treats a 4403 close as terminal and stops reconnecting", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useDocumentSync("/tmp/ep.json", () => undefined, true),
    );
    try {
      await act(async () => {
        FakeWebSocket.instances[0].close(4403);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("chains file_before across an own-client Applied so the poll can skip it", async () => {
    renderHook(() => useDocumentSync("/tmp/ep.json", () => undefined, true));
    const F1 = { mtime_ns: 100, size: 5 };
    const F2 = { mtime_ns: 200, size: 6 };
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Snapshot",
        server_seq: 1,
        snapshot: { server_seq: 1, project: minimalProject(), file: F1 },
      });
    });
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 2,
        command: { client_id: "someone-else" },
        snapshot: {
          server_seq: 2,
          patch: { tracks: [track("guest")] },
          file_before: F1,
          file: F2,
        },
      });
    });
    expect(pollSnapshotAlreadyApplied({ ...F2, server_seq: 2 })).toBe(true);

    const F9 = { mtime_ns: 900, size: 9 };
    const F3 = { mtime_ns: 300, size: 7 };
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        server_seq: 3,
        command: { client_id: "someone-else" },
        snapshot: {
          server_seq: 3,
          patch: { tracks: [track("guest")] },
          file_before: F9,
          file: F3,
        },
      });
    });
    expect(pollSnapshotAlreadyApplied({ ...F3, server_seq: 3 })).toBe(false);
  });

  it("drains the offline queue on the sanity cadence, plus online", async () => {
    vi.useFakeTimers();
    const { requestHostDrainLazy } = await import("../state/requestDrainLazy");
    vi.mocked(requestHostDrainLazy).mockClear();
    const { unmount } = renderHook(() =>
      useDocumentSync("/tmp/ep.json", () => undefined, true),
    );
    try {
      await act(async () => {
        FakeWebSocket.instances[0].open();
      });
      expect(requestHostDrainLazy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(requestHostDrainLazy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SANITY_POLL_MS - 10_000);
      });
      expect(requestHostDrainLazy).toHaveBeenCalledTimes(2);

      await act(async () => {
        window.dispatchEvent(new Event("online"));
      });
      expect(requestHostDrainLazy).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("resyncs from the hello Snapshot after a reconnect, with no poll", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      useDocumentSync("/tmp/ep.json", () => undefined, true),
    );
    try {
      await act(async () => {
        FakeWebSocket.instances[0].open();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          server_seq: 2,
          snapshot: { server_seq: 2, patch: { tracks: [track("mid")] } },
        });
      });
      expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
        "mid",
      ]);

      await act(async () => {
        FakeWebSocket.instances[0].close(1011);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);

      await act(async () => {
        FakeWebSocket.instances[1].open();
      });
      await act(async () => {
        FakeWebSocket.instances[1].emit({
          type: "Snapshot",
          server_seq: 5,
          snapshot: {
            server_seq: 5,
            project: { ...minimalProject(), tracks: [track("after")] },
          },
        });
      });
      expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
        "after",
      ]);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("queues a peer frame, flushes it via applyDocumentResult, then drops the own echo", async () => {
    renderHook(() => useDocumentSync("/tmp/ep.json", () => undefined, true));
    const listener = vi.fn();
    const unsub = useDawStore.subscribe(listener);
    try {
      // Peer's Applied at seq 2 arrives but is only queued, not flushed yet.
      await act(async () => {
        FakeWebSocket.instances[0].deliver({
          type: "Applied",
          server_seq: 2,
          command: { client_id: "peer" },
          snapshot: {
            server_seq: 2,
            patch: { tracks: [track("peer")] },
          },
        });
      });
      expect(
        useDawStore.getState().project?.tracks.map((t) => t.id),
      ).not.toEqual(["peer"]);

      // The local HTTP result for this client's own edit at seq 3 flushes the
      // queue first (applying the queued peer frame), then applies itself.
      listener.mockClear();
      await act(async () => {
        applyDocumentResult({
          command: { client_id: documentClientId() },
          snapshot: {
            server_seq: 3,
            patch: { tracks: [track("peer"), track("own")] },
          },
        });
      });
      expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
        "peer",
        "own",
      ]);
      expect(listener).toHaveBeenCalledTimes(2);

      // The WS echo of that same own-client seq-3 command is dropped.
      listener.mockClear();
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          server_seq: 3,
          command: { client_id: documentClientId() },
          snapshot: {
            server_seq: 3,
            patch: { tracks: [track("stale-echo")] },
          },
        });
      });
      expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
        "peer",
        "own",
      ]);

      // A later peer frame at seq 4 still applies normally.
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          server_seq: 4,
          command: { client_id: "peer" },
          snapshot: {
            server_seq: 4,
            patch: { tracks: [track("peer4")] },
          },
        });
      });
      expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
        "peer4",
      ]);
    } finally {
      unsub();
    }
  });

  it("drops a frame queued before unmount instead of applying it", async () => {
    const { unmount } = renderHook(() =>
      useDocumentSync("/tmp/ep.json", () => undefined, true),
    );
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.deliver({
        type: "Applied",
        server_seq: 2,
        snapshot: {
          server_seq: 2,
          patch: { tracks: [track("late")] },
        },
      });
    });
    unmount();
    await act(async () => {
      const { flushInbound } = await import("../sync/inboundQueue");
      flushInbound();
    });
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).not.toEqual(
      ["late"],
    );
  });

  it("drops malformed and non-document frames at receipt without queuing", async () => {
    renderHook(() => useDocumentSync("/tmp/ep.json", () => undefined, true));
    const socket = FakeWebSocket.instances[0];
    const { pendingInboundCount } = await import("../sync/inboundQueue");
    socket.onmessage?.({ data: "{not json" });
    socket.deliver({ type: "Presence", clients: [] });
    socket.deliver({ type: "Applied", server_seq: 3 });
    expect(pendingInboundCount()).toBe(0);
  });
});
