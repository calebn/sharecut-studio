import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollSnapshotAlreadyApplied,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { useDocumentSync } from "./useDocumentSync";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code = 1000) {
    this.closed = true;
    this.onclose?.({ code });
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

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
    FakeWebSocket.instances = [];
    resetDocumentSeqForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges patch.tracks, ignores non-document frames, and keeps comments-only merges", async () => {
    renderHook(() =>
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
    );
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
    renderHook(() =>
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
    );
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
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
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
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
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
    renderHook(() =>
      useDocumentSync("/tmp/ep.json", minimalProject(), () => undefined, true),
    );
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
});
