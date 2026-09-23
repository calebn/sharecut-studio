import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
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

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("useSessionSync presence", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
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
  });

  it("advances the applied cursor to the published last_command_id", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { postSessionState } = await import("../api");
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
      // Let the WebSocket open (microtask) before the publish debounce fires.
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(postSessionState).toHaveBeenCalled();
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
});
