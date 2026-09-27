import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import type { SessionState } from "../types/session";
import { useSessionSync } from "./useSessionSync";

vi.mock("../api", () => ({
  loadSessionMeta: vi.fn(async () => ({
    path: "",
    mtime_ns: 0,
    size: 0,
    exists: false,
  })),
  loadSessionState: vi.fn(async () => null),
  postSessionState: vi.fn(async () => ({
    server_seq: 1,
    last_command_id: "cmd-1",
  })),
}));

describe("useSessionSync presence", () => {
  beforeEach(async () => {
    FakeWebSocket.reset();
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const { postSessionState, loadSessionMeta } = await import("../api");
    vi.mocked(postSessionState).mockClear();
    vi.mocked(loadSessionMeta).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Presence over WS with type first and skips HTTP heartbeat while open", async () => {
    const interval = vi.spyOn(window, "setInterval");
    renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({ playhead_sec: 1, is_playing: true }),
        false,
        0,
        null,
        true,
        "k",
        true,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeWebSocket.instances[0].url).toContain("label=Host");
    interval.mockClear();
    useDawStore.setState({ playheadSec: 3, isPlaying: true });
    await act(async () => {
      await Promise.resolve();
    });
    const frames = FakeWebSocket.instances[0].sent.map(
      (s) => JSON.parse(s) as { type: string },
    );
    expect(frames.some((f) => f.type === "Presence")).toBe(true);
    const raw = FakeWebSocket.instances[0].sent.find((s) =>
      s.includes('"Presence"'),
    );
    expect(raw?.startsWith('{"type":"Presence"')).toBe(true);
    const heartbeatCalls = interval.mock.calls.filter((c) => c[1] === 200);
    expect(heartbeatCalls).toHaveLength(0);
    interval.mockRestore();
  });

  it("does not stamp localClientId when session sync is disabled", () => {
    useDawStore.setState({ localClientId: null });
    renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({}),
        true,
        0,
        null,
        false,
        "k",
        false,
      ),
    );
    expect(useDawStore.getState().localClientId).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("applies Presence roster and server_time_ns", async () => {
    renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({}),
        true,
        0,
        null,
        false,
        "k",
        true,
      ),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Presence",
        server_time_ns: (Date.now() + 400) * 1e6,
        clients: [{ client_id: "x", role: "viewer", label: "Ada" }],
      } satisfies Partial<SessionState> & { type: string; clients: unknown });
    });
    expect(useDawStore.getState().sessionClients[0]?.client_id).toBe("x");
    expect(useDawStore.getState().serverClockOffsetMs).not.toBe(0);
  });

  it("stores record-plane snapshots on the host record store", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    useRecordHostStore.getState().setSnapshot(null);
    renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({}),
        true,
        0,
        null,
        false,
        "k",
        true,
      ),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Snapshot",
        plane: "record",
        snapshot: {
          session_id: "room1",
          state: "recording",
          take_index: 0,
          recording_ms: 1000,
          participants: [],
          caps: { recorded: 4, producers: 2 },
        },
      });
    });
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
  });

  it("clears host record connected when the session socket closes", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setConnected(false);
    renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({}),
        true,
        0,
        null,
        false,
        "k",
        true,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(useRecordHostStore.getState().connected).toBe(true);
    await act(async () => {
      FakeWebSocket.instances[0].close();
    });
    expect(useRecordHostStore.getState().connected).toBe(false);
    expect(useRecordHostStore.getState().dropped).toBe(true);
  });

  it("does not mark the host record socket dropped on unmount", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    useRecordHostStore.getState().resetConnection();
    const { unmount } = renderHook(() =>
      useSessionSync(
        "/tmp/ep.project.json",
        vi.fn(),
        () => ({}),
        true,
        0,
        null,
        false,
        "k",
        true,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(useRecordHostStore.getState().connected).toBe(true);
    unmount();
    expect(useRecordHostStore.getState().connected).toBe(false);
    expect(useRecordHostStore.getState().dropped).toBe(false);
  });

  it("ignores the old socket's late close after a project switch", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    const { sendRecordHostCommand } = await import("../record/hostWire");
    useRecordHostStore.getState().resetConnection();
    const { rerender } = renderHook(
      ({ path }: { path: string }) =>
        useSessionSync(
          path,
          vi.fn(),
          () => ({}),
          true,
          0,
          null,
          false,
          "k",
          true,
        ),
      { initialProps: { path: "/tmp/ep.project.json" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    const old = FakeWebSocket.instances[0];
    const lateClose = old.onclose;
    old.close = () => undefined; // real sockets fire close later
    rerender({ path: "/tmp/other.project.json" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(old.onclose).toBeNull();
    expect(useRecordHostStore.getState().connected).toBe(true);
    act(() => lateClose?.({ code: 1000 }));
    expect(useRecordHostStore.getState().connected).toBe(true);
    expect(useRecordHostStore.getState().dropped).toBe(false);
    expect(sendRecordHostCommand("SetMuted", { muted: true })).toBe(true);
  });

  it("advances the applied cursor from the ViewerState echo", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      const apply = vi.fn();
      const clientIdRef: { current: string | null } = { current: null };
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          apply,
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      // Let the WebSocket open (microtask) before the publish debounce fires.
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(postSessionState).not.toHaveBeenCalled();
      const viewerStateFrames = FakeWebSocket.instances[0].sent
        .map(
          (s) =>
            JSON.parse(s) as {
              type: string;
              snapshot?: { client_id?: string };
            },
        )
        .filter((f) => f.type === "ViewerState");
      expect(viewerStateFrames).toHaveLength(1);
      clientIdRef.current = viewerStateFrames[0].snapshot?.client_id ?? null;
      expect(clientIdRef.current).toBeTruthy();

      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Echo",
          command: {
            type: "ViewerState",
            client_id: clientIdRef.current,
            role: "viewer",
          },
          snapshot: { server_seq: 1, last_command_id: "cmd-1" },
        });
      });
      // Cursor now holds { serverSeq: 1, commandId: "cmd-1" }: an agent echo of
      // that same command is deduped instead of re-applied.
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
          snapshot: {
            server_seq: 1,
            last_command_id: "cmd-1",
            origin: "agent",
            last_role: "agent",
            playhead_sec: 9,
          },
        });
      });
      expect(apply).not.toHaveBeenCalled();
      // A newer agent command still applies.
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Applied",
          command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
          snapshot: {
            server_seq: 2,
            last_command_id: "cmd-2",
            origin: "agent",
            last_role: "agent",
            playhead_sec: 9,
          },
        });
      });
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("republishes over HTTP when an open socket never echoes a ViewerState", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const frames = FakeWebSocket.instances[0].sent
        .map(
          (s) =>
            JSON.parse(s) as {
              type: string;
              snapshot?: { client_id?: string };
            },
        )
        .filter((f) => f.type === "ViewerState");
      expect(frames).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1400);
      });
      expect(postSessionState).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
      expect(postSessionState).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({ client_id: frames[0].snapshot?.client_id }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the oldest unechoed ViewerState deadline across later sends", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      const { rerender } = renderHook(
        ({ publishKey }: { publishKey: string }) =>
          useSessionSync(
            "/tmp/ep.project.json",
            vi.fn(),
            () => ({ playhead_sec: 0, is_playing: false }),
            false,
            0,
            null,
            false,
            publishKey,
            true,
          ),
        { initialProps: { publishKey: "k1" } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const viewerStateFrames = () =>
        FakeWebSocket.instances[0].sent.filter((s) =>
          s.includes('"ViewerState"'),
        );
      expect(viewerStateFrames()).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      rerender({ publishKey: "k2" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(viewerStateFrames()).toHaveLength(2);
      expect(postSessionState).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back once the ViewerState echo arrives", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const frames = FakeWebSocket.instances[0].sent
        .map(
          (s) =>
            JSON.parse(s) as {
              type: string;
              snapshot?: { client_id?: string };
            },
        )
        .filter((f) => f.type === "ViewerState");
      const clientId = frames[0].snapshot?.client_id;

      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Echo",
          command: { type: "ViewerState", client_id: clientId, role: "viewer" },
          snapshot: { server_seq: 1, last_command_id: "cmd-1" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(postSessionState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to HTTP when the server rejects a ViewerState frame", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Error",
          code: "invalid_viewer_state",
          detail: "bad",
        });
        await Promise.resolve();
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a selection change as one WS frame and zero POSTs while live", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState, loadSessionMeta } = await import("../api");
      const { rerender } = renderHook(
        ({ publishKey }: { publishKey: string }) =>
          useSessionSync(
            "/tmp/ep.project.json",
            vi.fn(),
            () => ({ playhead_sec: 0, is_playing: false }),
            false,
            0,
            null,
            false,
            publishKey,
            true,
          ),
        { initialProps: { publishKey: "k1" } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      rerender({ publishKey: "k2" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const viewerStateFrames = FakeWebSocket.instances[0].sent.filter((s) =>
        s.includes('"ViewerState"'),
      );
      expect(viewerStateFrames).toHaveLength(2);
      expect(postSessionState).not.toHaveBeenCalled();
      expect(vi.mocked(loadSessionMeta).mock.calls.length).toBeLessThanOrEqual(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to POST /api/session/state while the socket is down, without a meta GET", async () => {
    FakeWebSocket.autoOpen = false;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState, loadSessionMeta } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
      const sentTypes = FakeWebSocket.instances[0].sent.map(
        (s) => (JSON.parse(s) as { type: string }).type,
      );
      expect(sentTypes).not.toContain("ViewerState");
      expect(loadSessionMeta).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("republishes over HTTP when the socket drops", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].close();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const frames = FakeWebSocket.instances[1].sent.filter((s) =>
        s.includes('"ViewerState"'),
      );
      expect(frames.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("republishes over HTTP once when the socket drops with a ViewerState unechoed", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          vi.fn(),
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const frames = FakeWebSocket.instances[0].sent.filter((s) =>
        s.includes('"ViewerState"'),
      );
      expect(frames).toHaveLength(1);
      expect(postSessionState).not.toHaveBeenCalled();

      await act(async () => {
        FakeWebSocket.instances[0].close();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(postSessionState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer WebSocket cursor when an older HTTP publish finishes", async () => {
    FakeWebSocket.autoOpen = false;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      let finishPublish: ((state: SessionState) => void) | undefined;
      vi.mocked(postSessionState).mockImplementationOnce(
        () =>
          new Promise<SessionState>((resolve) => {
            finishPublish = resolve;
          }),
      );
      const apply = vi.fn();
      const { rerender } = renderHook(
        ({
          revision,
          commandId,
        }: {
          revision: number;
          commandId: string | null;
        }) =>
          useSessionSync(
            "/tmp/ep.project.json",
            apply,
            () => ({ playhead_sec: 0, is_playing: false }),
            false,
            revision,
            commandId,
            false,
            "k",
            true,
          ),
        { initialProps: { revision: 0, commandId: null as string | null } },
      );
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(finishPublish).toBeDefined();

      const applied = (seq: number, commandId: string) => ({
        type: "Applied",
        command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
        snapshot: {
          server_seq: seq,
          last_command_id: commandId,
          origin: "agent",
          last_role: "agent",
          playhead_sec: seq,
        },
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit(applied(2, "cmd-2"));
      });
      expect(apply).toHaveBeenCalledTimes(1);
      rerender({ revision: 2, commandId: "cmd-2" });

      await act(async () => {
        finishPublish?.({
          server_seq: 1,
          last_command_id: "cmd-1",
        } as SessionState);
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit(applied(2, "cmd-2"));
      });
      expect(apply).toHaveBeenCalledTimes(1);
      await act(async () => {
        FakeWebSocket.instances[0].emit(applied(3, "cmd-3"));
      });
      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cursor monotonic when wsReady flips during an in-flight HTTP publish", async () => {
    FakeWebSocket.autoOpen = false;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      let finishPublish: ((state: SessionState) => void) | undefined;
      vi.mocked(postSessionState).mockImplementationOnce(
        () =>
          new Promise<SessionState>((resolve) => {
            finishPublish = resolve;
          }),
      );
      const apply = vi.fn();
      renderHook(() =>
        useSessionSync(
          "/tmp/ep.project.json",
          apply,
          () => ({ playhead_sec: 0, is_playing: false }),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(finishPublish).toBeDefined();
      const sock = FakeWebSocket.instances[0];
      await act(async () => {
        sock.readyState = FakeWebSocket.OPEN;
        sock.onopen?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const frames = sock.sent
        .map(
          (s) =>
            JSON.parse(s) as {
              type: string;
              snapshot?: { client_id?: string };
            },
        )
        .filter((f) => f.type === "ViewerState");
      expect(frames).toHaveLength(1);
      await act(async () => {
        sock.emit({
          type: "Echo",
          command: {
            type: "ViewerState",
            client_id: frames[0].snapshot?.client_id,
            role: "viewer",
          },
          snapshot: { server_seq: 3, last_command_id: "cmd-3" },
        });
      });
      // The torn-down effect's POST finishes late with an older sequence.
      await act(async () => {
        finishPublish?.({
          server_seq: 1,
          last_command_id: "cmd-1",
        } as SessionState);
        await Promise.resolve();
      });
      const applied = (seq: number, commandId: string) => ({
        type: "Applied",
        command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
        snapshot: {
          server_seq: seq,
          last_command_id: commandId,
          origin: "agent",
          last_role: "agent",
          playhead_sec: seq,
        },
      });
      await act(async () => {
        sock.emit(applied(3, "cmd-3"));
      });
      expect(apply).not.toHaveBeenCalled();
      await act(async () => {
        sock.emit(applied(4, "cmd-4"));
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(postSessionState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
