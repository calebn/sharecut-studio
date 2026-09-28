import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollSnapshotAlreadyApplied,
  resetDocumentSeqForTests,
} from "../document/cursor";
import { currentServerClockOffsetMs } from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import type { SessionState } from "../types/session";
import { useGuestSync } from "./useGuestSync";

const loadProject = vi.fn();
const loadProjectMeta = vi.fn();

vi.mock("../api", () => ({
  loadProject: (...args: unknown[]) => loadProject(...args),
  loadProjectMeta: (...args: unknown[]) => loadProjectMeta(...args),
}));

vi.mock("../state/offlineStore", () => ({
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));

vi.mock("../state/drainOfflineQueue", () => ({
  drainOfflineQueue: vi.fn(async () => undefined),
}));

describe("useGuestSync", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    resetDocumentSeqForTests();
    loadProject.mockReset();
    loadProjectMeta.mockReset();
    loadProjectMeta.mockResolvedValue({ mtime_ns: 1, size: 1, server_seq: 0 });
    loadProject.mockResolvedValue(minimalProject());
    useDawStore.getState().hydrate("share:tok123", minimalProject());
    useDawStore.getState().setActivityJob(null);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:8765" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects to the guest daw ws and demuxes session vs document", async () => {
    const apply = vi.fn();
    const setProject = vi.fn();

    renderHook(() => useGuestSync("share:tok123", apply, setProject, true));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain(
      "/api/review/tok123/daw/ws",
    );
    expect(FakeWebSocket.instances[0].url).toContain("client_id=");
    expect(FakeWebSocket.instances[0].url).toContain("name=");

    const sessionSnap = {
      type: "Snapshot",
      plane: "session",
      snapshot: {
        playhead_sec: 1.5,
        server_seq: 2,
        is_playing: false,
      } as SessionState,
    };
    await act(async () => {
      FakeWebSocket.instances[0].emit(sessionSnap);
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ playhead_sec: 1.5 }),
    );

    const nextProject = minimalProject({
      meta: { name: "ep2", workspace_dir: "/tmp/test" },
    });
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: nextProject,
        },
      });
    });
    expect(useDawStore.getState().project?.meta.name).toBe("ep2");
  });

  it("applies Presence clients roster", async () => {
    renderHook(() => useGuestSync("share:tok", vi.fn(), vi.fn(), true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Presence",
        plane: "session",
        clients: [{ client_id: "g1", role: "viewer", label: "Guest" }],
      });
    });
    expect(useDawStore.getState().sessionClients).toEqual({
      g1: { client_id: "g1", role: "viewer", label: "Guest" },
    });
  });

  it("adopts the server-assigned session client_id", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    expect(useDawStore.getState().localClientId).toBeNull();
    const url = FakeWebSocket.instances[0].url;
    expect(url).toContain("client_id=");
    expect(url).not.toContain("guest-");
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Snapshot",
        plane: "session",
        client_id: "guest-tok123-viewerabc",
        snapshot: { playhead_sec: 0, server_seq: 1 } as SessionState,
      });
    });
    expect(useDawStore.getState().localClientId).toBe("guest-tok123-viewerabc");
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        client_id: "host-tab",
        snapshot: { server_seq: 2, comments: [] },
      });
    });
    expect(useDawStore.getState().localClientId).toBe("guest-tok123-viewerabc");
  });

  it("applies server_time_ns clock offset", async () => {
    renderHook(() => useGuestSync("share:tok", vi.fn(), vi.fn(), true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Presence",
        server_time_ns: (Date.now() + 200) * 1e6,
        clients: [],
      });
    });
    expect(currentServerClockOffsetMs()).not.toBe(0);
  });

  it("merges comments when document snapshot has no project", async () => {
    const apply = vi.fn();
    const setProject = vi.fn();
    const project = minimalProject({
      comments: [{ id: "c1", body: "old" } as never],
    });
    useDawStore.getState().hydrate("share:tok", project);

    renderHook(() => useGuestSync("share:tok", apply, setProject, true));

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 1,
          comments: [{ id: "c2", body: "hi" }],
        },
      });
    });
    expect(useDawStore.getState().project?.comments).toEqual([
      { id: "c2", body: "hi" },
    ]);
  });

  it("ignores older document server_seq", async () => {
    const setProject = vi.fn();
    renderHook(() => useGuestSync("share:tok", vi.fn(), setProject, true));

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: minimalProject({
            meta: { name: "a", workspace_dir: "/tmp" },
          }),
        },
      });
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 3,
          project: minimalProject({
            meta: { name: "b", workspace_dir: "/tmp" },
          }),
        },
      });
    });
    expect(useDawStore.getState().project?.meta.name).toBe("a");
  });

  it("does not apply a fallback poll whose meta seq is behind document seq", async () => {
    let resolveMeta: (value: {
      mtime_ns: number;
      size: number;
      server_seq: number;
    }) => void = () => undefined;
    loadProjectMeta.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve;
        }),
    );
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: minimalProject({
            meta: { name: "from-ws", workspace_dir: "/tmp/test" },
          }),
        },
      });
    });
    await act(async () => {
      FakeWebSocket.instances[0].close();
    });
    await act(async () => {
      resolveMeta({ mtime_ns: 1, size: 1, server_seq: 3 });
    });
    expect(loadProject).not.toHaveBeenCalled();
    expect(useDawStore.getState().project?.meta.name).toBe("from-ws");
  });

  it("does not connect when disabled or non-share path", () => {
    renderHook(() => useGuestSync("/local/path.json", vi.fn(), vi.fn(), false));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("stores guest progress plane events as the activity job", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "progress",
        plane: "progress",
        kind: "update",
        task_id: "guest_render_preview",
        label: "Render preview",
        message: "Mixing stems",
        status: "running",
        elapsed_sec: 2,
      });
    });
    const job = useDawStore.getState().activityJob;
    expect(job?.kind).toBe("agent");
    expect(job?.status).toBe("running");
    expect(job?.message).toBe("Mixing stems");
    expect(job?.project_path).toBe("");
  });

  it("reports whether the guest socket is open", async () => {
    const { result } = renderHook(() =>
      useGuestSync("share:tok123", vi.fn(), vi.fn(), true),
    );
    expect(result.current).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
    await act(async () => {
      FakeWebSocket.instances[0].close();
    });
    expect(result.current).toBe(false);
  });

  it("reports false when disabled or on a non-share path", () => {
    const { result } = renderHook(() =>
      useGuestSync("/local/path.json", vi.fn(), vi.fn(), false),
    );
    expect(result.current).toBe(false);
  });

  it("notes a document-plane project snapshot's file for the poll skip", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Snapshot",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: minimalProject(),
          file: { mtime_ns: 42, size: 9 },
        },
      });
    });
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 42, size: 9, server_seq: 5 }),
    ).toBe(true);
  });

  it("covers the first handshake with the fallback poll until the socket opens", async () => {
    vi.useFakeTimers();
    FakeWebSocket.autoOpen = false;
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    expect(loadProjectMeta).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(loadProjectMeta).toHaveBeenCalledTimes(1);
    await act(async () => {
      FakeWebSocket.instances[0].open();
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(loadProjectMeta).toHaveBeenCalledTimes(1);
  });

  it("coalesces queued guest Presence frames into the newest roster", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.deliver({
        type: "Presence",
        plane: "session",
        clients: [{ client_id: "g1", role: "viewer", label: "Guest" }],
      });
      sock.deliver({
        type: "Presence",
        plane: "session",
        clients: [
          { client_id: "g1", role: "viewer", label: "Guest" },
          { client_id: "g2", role: "viewer", label: "Guest 2" },
        ],
      });
      const { pendingInboundCount, flushInbound } = await import(
        "../sync/inboundQueue"
      );
      expect(pendingInboundCount()).toBe(1);
      flushInbound();
    });
    expect(useDawStore.getState().sessionClients).toEqual({
      g1: { client_id: "g1", role: "viewer", label: "Guest" },
      g2: { client_id: "g2", role: "viewer", label: "Guest 2" },
    });
  });

  it("swallows a failed document resync load instead of rejecting unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      loadProject.mockRejectedValueOnce(new Error("offline"));
      renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          plane: "document",
          server_seq: 2,
          snapshot: { server_seq: 2, resync: true },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(loadProject).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("detaches the socket's handlers on unmount", () => {
    const { unmount } = renderHook(() =>
      useGuestSync("share:tok123", vi.fn(), vi.fn(), true),
    );
    const sock = FakeWebSocket.instances[0];
    unmount();
    expect(sock.closed).toBe(true);
    expect(sock.onmessage).toBeNull();
    expect(sock.onclose).toBeNull();
  });

  it("applies a PresenceDelta for a known client at the current roster version", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.emit({
        type: "Presence",
        plane: "session",
        roster_version: 4,
        clients: [{ client_id: "g1", role: "viewer", label: "Guest" }],
      });
    });
    await act(async () => {
      sock.emit({
        type: "PresenceDelta",
        plane: "session",
        author_client_id: "g1",
        roster_version: 4,
        changes: { label: "Guest2" },
      });
    });
    expect(useDawStore.getState().sessionClients.g1?.label).toBe("Guest2");
    expect(useDawStore.getState().sessionRosterVersion).toBe(4);
  });

  it("sends exactly one RosterRequest on a version gap", async () => {
    renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.emit({
        type: "Presence",
        plane: "session",
        roster_version: 4,
        clients: [{ client_id: "g1", role: "viewer", label: "Guest" }],
      });
    });
    sock.sent = [];
    await act(async () => {
      sock.emit({
        type: "PresenceDelta",
        plane: "session",
        author_client_id: "g1",
        roster_version: 9,
        changes: { label: "Guest2" },
      });
    });
    const rosterRequests = sock.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((f) => f.type === "RosterRequest");
    expect(rosterRequests).toHaveLength(1);
    expect(useDawStore.getState().sessionClients.g1?.label).toBe("Guest");
  });
});
