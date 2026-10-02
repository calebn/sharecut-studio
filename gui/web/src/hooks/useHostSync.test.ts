import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentServerClockOffsetMs } from "../presence/clock";
import { useDawStore } from "../state/dawStore";
import { flushInbound, pendingInboundCount } from "../sync/inboundQueue";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { stubRaf } from "../test/raf";
import type { SessionState } from "../types/session";
import { SANITY_POLL_MS } from "./useFileMetaPoll";
import { useHostSync } from "./useHostSync";

vi.mock("../state/requestDrainLazy", () => ({ requestHostDrainLazy: vi.fn() }));

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

describe("useHostSync presence", () => {
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
      useHostSync(
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
      useHostSync(
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
      useHostSync(
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
        plane: "session",
        type: "Presence",
        server_time_ns: (Date.now() + 400) * 1e6,
        clients: [{ client_id: "x", role: "viewer", label: "Ada" }],
      } satisfies Partial<SessionState> & {
        plane: string;
        type: string;
        clients: unknown;
      });
    });
    expect(useDawStore.getState().sessionClients.x?.client_id).toBe("x");
    expect(currentServerClockOffsetMs()).not.toBe(0);
  });

  it("stores record-plane snapshots on the host record store", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    useRecordHostStore.getState().setSnapshot(null);
    renderHook(() =>
      useHostSync(
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
      useHostSync(
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
      useHostSync(
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
        useHostSync(path, vi.fn(), () => ({}), true, 0, null, false, "k", true),
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
        useHostSync(
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
          plane: "session",
          type: "Echo",
          command: {
            type: "ViewerState",
            client_id: clientIdRef.current,
            role: "viewer",
          },
          snapshot: {
            server_seq: 1,
            last_command_id: "cmd-1",
            playhead_sec: 1,
            is_playing: true,
          },
        });
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Applied",
          prev_seq: 0,
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
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Applied",
          prev_seq: 1,
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
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({ playhead_sec: 9, is_playing: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending ViewerState fallback during source preview and recovers afterward", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      const { rerender } = renderHook(
        ({ suppressed }) =>
          useHostSync(
            "/tmp/ep.project.json",
            vi.fn(),
            () => ({ playhead_sec: 42, is_playing: false }),
            suppressed,
            0,
            null,
            false,
            "k",
            true,
          ),
        { initialProps: { suppressed: false } },
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      const socket = FakeWebSocket.instances[0];
      expect(
        socket.sent.filter((frame) => frame.includes('"ViewerState"')),
      ).toHaveLength(1);
      rerender({ suppressed: true });
      await act(async () => {
        socket.emit({
          plane: "session",
          type: "Error",
          code: "invalid_viewer_state",
          detail: "bad",
        });
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(postSessionState).not.toHaveBeenCalled();
      expect(
        socket.sent.filter((frame) => frame.includes('"ViewerState"')),
      ).toHaveLength(1);
      rerender({ suppressed: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1660);
      });
      expect(
        socket.sent.filter((frame) => frame.includes('"ViewerState"')),
      ).toHaveLength(2);
      expect(postSessionState).toHaveBeenCalledTimes(1);
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
        useHostSync(
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
          useHostSync(
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

  it("hands the echo deadline to the next unechoed ViewerState frame after a partial Echo", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      const { rerender } = renderHook(
        ({ publishKey }: { publishKey: string }) =>
          useHostSync(
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
      const viewerStateFrames = () =>
        FakeWebSocket.instances[0].sent
          .map(
            (s) =>
              JSON.parse(s) as {
                type: string;
                snapshot?: { client_id?: string };
              },
          )
          .filter((f) => f.type === "ViewerState");
      const echo = (clientId: string | undefined, seq: number) =>
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Echo",
          command: { type: "ViewerState", client_id: clientId, role: "viewer" },
          snapshot: { server_seq: seq, last_command_id: `cmd-${seq}` },
        });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(viewerStateFrames()).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(840);
      });
      rerender({ publishKey: "k2" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(viewerStateFrames()).toHaveLength(2);

      const clientId = viewerStateFrames()[0].snapshot?.client_id;
      await act(async () => {
        echo(clientId, 1);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(postSessionState).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
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

  it("does not fall back once every in-flight ViewerState frame is echoed", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
      const { rerender } = renderHook(
        ({ publishKey }: { publishKey: string }) =>
          useHostSync(
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
      const viewerStateFrames = () =>
        FakeWebSocket.instances[0].sent
          .map(
            (s) =>
              JSON.parse(s) as {
                type: string;
                snapshot?: { client_id?: string };
              },
          )
          .filter((f) => f.type === "ViewerState");
      const echo = (clientId: string | undefined, seq: number) =>
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Echo",
          command: { type: "ViewerState", client_id: clientId, role: "viewer" },
          snapshot: { server_seq: seq, last_command_id: `cmd-${seq}` },
        });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(viewerStateFrames()).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(840);
      });
      rerender({ publishKey: "k2" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(viewerStateFrames()).toHaveLength(2);

      const clientId = viewerStateFrames()[0].snapshot?.client_id;
      await act(async () => {
        echo(clientId, 1);
        echo(clientId, 2);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(postSessionState).not.toHaveBeenCalled();
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
        useHostSync(
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
          plane: "session",
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

  it("ends the ViewerState echo wait at receipt, before the inbound queue flushes", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      stubRaf();
      const { postSessionState } = await import("../api");
      renderHook(() =>
        useHostSync(
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
        FakeWebSocket.instances[0].deliver({
          plane: "session",
          type: "Echo",
          command: { type: "ViewerState", client_id: clientId, role: "viewer" },
          snapshot: { server_seq: 1, last_command_id: "cmd-1" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(pendingInboundCount()).toBe(1);
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
        useHostSync(
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
          plane: "session",
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
          useHostSync(
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
        useHostSync(
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
        useHostSync(
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
        useHostSync(
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
          useHostSync(
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
        plane: "session",
        type: "Applied",
        prev_seq: seq - 1,
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
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Snapshot",
          snapshot: {
            server_seq: 1,
            last_command_id: "cmd-1",
            origin: "viewer",
            last_role: "viewer",
            playhead_sec: 0,
            is_playing: false,
          },
        });
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
        useHostSync(
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
          plane: "session",
          type: "Echo",
          command: {
            type: "ViewerState",
            client_id: frames[0].snapshot?.client_id,
            role: "viewer",
          },
          snapshot: { server_seq: 3, last_command_id: "cmd-3" },
        });
      });
      await act(async () => {
        finishPublish?.({
          server_seq: 1,
          last_command_id: "cmd-1",
        } as SessionState);
        await Promise.resolve();
      });
      const applied = (seq: number, commandId: string) => ({
        plane: "session",
        type: "Applied",
        prev_seq: seq - 1,
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

  it("skips loadSessionState on the sanity poll when meta seq is not newer than the cursor", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { loadSessionMeta, loadSessionState } = await import("../api");
      vi.mocked(loadSessionMeta).mockResolvedValueOnce({
        path: "/tmp/ep.project.json",
        mtime_ns: 1,
        size: 1,
        exists: true,
        server_seq: 3,
      });
      renderHook(() =>
        useHostSync(
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
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Snapshot",
          snapshot: {
            server_seq: 3,
            last_command_id: "cmd-3",
            origin: "agent",
            last_role: "agent",
            playhead_sec: 0,
          },
        });
      });

      vi.mocked(loadSessionMeta).mockResolvedValueOnce({
        path: "/tmp/ep.project.json",
        mtime_ns: 2,
        size: 1,
        exists: true,
        server_seq: 3,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SANITY_POLL_MS);
      });
      expect(loadSessionState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of Applied gaps into one full session resync", async () => {
    const { loadSessionState } = await import("../api");
    let finishResync: ((state: SessionState) => void) | undefined;
    vi.mocked(loadSessionState).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResync = resolve;
        }),
    );
    const apply = vi.fn();
    renderHook(() =>
      useHostSync(
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
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.emit({
        plane: "session",
        type: "Snapshot",
        snapshot: {
          server_seq: 1,
          last_command_id: "cmd-1",
          origin: "viewer",
          last_role: "viewer",
          playhead_sec: 0,
          is_playing: false,
        },
      });
    });
    await act(async () => {
      socket.deliver({
        plane: "session",
        type: "Applied",
        prev_seq: 2,
        server_seq: 3,
        command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
        snapshot: {
          server_seq: 3,
          last_command_id: "agent-3",
          last_client_id: "agent",
          origin: "agent",
          last_role: "agent",
          playhead_sec: 3,
        },
      });
      socket.deliver({
        plane: "session",
        type: "Applied",
        prev_seq: 2,
        server_seq: 3,
        command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
        snapshot: {
          server_seq: 3,
          last_command_id: "agent-3",
          last_client_id: "agent",
          origin: "agent",
          last_role: "agent",
          playhead_sec: 3,
        },
      });
      flushInbound();
    });
    expect(loadSessionState).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishResync?.({
        server_seq: 3,
        last_command_id: "viewer-3",
        last_client_id: "viewer",
        origin: "viewer",
        last_role: "viewer",
        playhead_sec: 3,
        is_playing: false,
      } as SessionState);
      await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        server_seq: 3,
        last_command_id: "agent-3",
        last_client_id: "agent",
        origin: "agent",
        last_role: "agent",
      }),
    );
  });

  it("retries a host resync when a later gap arrives before the first read settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { loadSessionState } = await import("../api");
      const responses: Array<(state: SessionState) => void> = [];
      vi.mocked(loadSessionState).mockImplementation(
        () => new Promise((resolve) => responses.push(resolve)),
      );
      const apply = vi.fn();
      renderHook(() =>
        useHostSync(
          "/tmp/ep.project.json",
          apply,
          () => ({}),
          false,
          0,
          null,
          false,
          "k",
          true,
        ),
      );
      const socket = FakeWebSocket.instances[0];
      await act(async () => {
        socket.emit({
          plane: "session",
          type: "Snapshot",
          snapshot: {
            server_seq: 1,
            last_command_id: "cmd-1",
            origin: "viewer",
            last_role: "viewer",
            playhead_sec: 0,
            is_playing: false,
          },
        });
      });
      await act(async () => {
        socket.deliver({
          plane: "session",
          type: "Applied",
          prev_seq: 2,
          server_seq: 3,
          snapshot: {
            server_seq: 3,
            last_command_id: "cmd-3",
            playhead_sec: 3,
          },
        });
        flushInbound();
      });
      expect(loadSessionState).toHaveBeenCalledTimes(1);
      await act(async () => {
        socket.deliver({
          plane: "session",
          type: "Applied",
          prev_seq: 3,
          server_seq: 4,
          snapshot: {
            server_seq: 4,
            last_command_id: "cmd-4",
            playhead_sec: 4,
          },
        });
        flushInbound();
        responses[0]({
          server_seq: 3,
          last_command_id: "cmd-3",
          playhead_sec: 3,
        } as SessionState);
        await Promise.resolve();
      });
      expect(loadSessionState).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(loadSessionState).toHaveBeenCalledTimes(2);
      await act(async () => {
        responses[1]({
          server_seq: 4,
          last_command_id: "cmd-4",
          playhead_sec: 4,
        } as SessionState);
        await Promise.resolve();
      });
      expect(apply).toHaveBeenLastCalledWith(
        expect.objectContaining({ server_seq: 4, playhead_sec: 4 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an agent session from the sanity poll when meta seq advances", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { loadSessionMeta, loadSessionState } = await import("../api");
      vi.mocked(loadSessionMeta).mockResolvedValueOnce({
        path: "/tmp/ep.project.json",
        mtime_ns: 1,
        size: 1,
        exists: true,
        server_seq: 3,
      });
      const apply = vi.fn();
      renderHook(() =>
        useHostSync(
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
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          plane: "session",
          type: "Snapshot",
          snapshot: {
            server_seq: 3,
            last_command_id: "cmd-3",
            origin: "agent",
            last_role: "agent",
            playhead_sec: 0,
          },
        });
      });
      apply.mockClear();

      vi.mocked(loadSessionMeta).mockResolvedValueOnce({
        path: "/tmp/ep.project.json",
        mtime_ns: 2,
        size: 1,
        exists: true,
        server_seq: 4,
      });
      vi.mocked(loadSessionState).mockResolvedValueOnce({
        server_seq: 4,
        last_command_id: "cli-1",
        origin: "agent",
        last_role: "agent",
        playhead_sec: 9,
      } as SessionState);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SANITY_POLL_MS);
      });
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("three Presence frames plus an agent Applied commit once", async () => {
    const listener = vi.fn();
    const unsub = useDawStore.subscribe(listener);
    renderHook(() =>
      useHostSync(
        "/tmp/ep.project.json",
        useDawStore.getState().applyAgentSession,
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
    listener.mockClear();
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.deliver({
        plane: "session",
        type: "Presence",
        clients: [{ client_id: "a", role: "viewer" }],
      });
      sock.deliver({
        plane: "session",
        type: "Presence",
        clients: [
          { client_id: "a", role: "viewer" },
          { client_id: "b", role: "viewer" },
        ],
      });
      sock.deliver({
        plane: "session",
        type: "Presence",
        clients: [
          { client_id: "a", role: "viewer" },
          { client_id: "b", role: "viewer" },
          { client_id: "c", role: "viewer" },
        ],
      });
      sock.deliver({
        plane: "session",
        type: "Snapshot",
        snapshot: {
          server_seq: 0,
          last_command_id: null,
          origin: "viewer",
          last_role: "viewer",
          playhead_sec: 0,
          is_playing: false,
        },
      });
      sock.deliver({
        plane: "session",
        type: "Applied",
        prev_seq: 0,
        command: { role: "agent", type: "SetPlayhead", client_id: "agent" },
        snapshot: {
          server_seq: 1,
          last_command_id: "cmd-1",
          origin: "agent",
          last_role: "agent",
          playhead_sec: 9,
        },
      });
      const { flushInbound } = await import("../sync/inboundQueue");
      flushInbound();
    });
    unsub();
    expect(Object.keys(useDawStore.getState().sessionClients)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(useDawStore.getState().playheadSec).toBe(9);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a clock-only frame writes nothing to the store", async () => {
    const listener = vi.fn();
    renderHook(() =>
      useHostSync(
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
    const unsub = useDawStore.subscribe(listener);
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        plane: "session",
        type: "Ping",
        server_time_ns: (Date.now() + 100) * 1e6,
      });
    });
    unsub();
    expect(listener).not.toHaveBeenCalled();
  });

  it("queues recording snapshots until the inbound batch applies", async () => {
    const { useRecordHostStore } = await import("../record/hostStore");
    useRecordHostStore.getState().setSnapshot(null);
    renderHook(() =>
      useHostSync(
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
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.deliver({
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
    expect(useRecordHostStore.getState().snapshot).toBeNull();
    expect(pendingInboundCount()).toBe(1);
    act(() => flushInbound());
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
  });

  it("applies a PresenceDelta for a known client at the current roster version", async () => {
    renderHook(() =>
      useHostSync(
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
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "Presence",
        roster_version: 7,
        clients: [{ client_id: "x", role: "viewer", label: "Ada" }],
      });
    });
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "PresenceDelta",
        author_client_id: "x",
        roster_version: 7,
        changes: { label: "Ada2" },
      });
    });
    expect(useDawStore.getState().sessionClients.x?.label).toBe("Ada2");
    expect(useDawStore.getState().sessionRosterVersion).toBe(7);
  });

  it("sends exactly one RosterRequest on a version gap", async () => {
    renderHook(() =>
      useHostSync(
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
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "Presence",
        roster_version: 7,
        clients: [{ client_id: "x", role: "viewer", label: "Ada" }],
      });
    });
    sock.sent = [];
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "PresenceDelta",
        author_client_id: "x",
        roster_version: 9,
        changes: { label: "Ada2" },
      });
    });
    const rosterRequests = sock.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((f) => f.type === "RosterRequest");
    expect(rosterRequests).toHaveLength(1);
    expect(useDawStore.getState().sessionClients.x?.label).toBe("Ada");
  });

  it("sends a RosterRequest on a PresenceResync", async () => {
    renderHook(() =>
      useHostSync(
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
    const sock = FakeWebSocket.instances[0];
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "Presence",
        roster_version: 7,
        clients: [{ client_id: "x", role: "viewer", label: "Ada" }],
      });
    });
    sock.sent = [];
    await act(async () => {
      sock.emit({
        plane: "session",
        type: "PresenceResync",
      });
    });
    const rosterRequests = sock.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((f) => f.type === "RosterRequest");
    expect(rosterRequests).toHaveLength(1);
  });
});
