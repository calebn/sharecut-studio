import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { commentsQueueKey, postLiveComment } from "./liveCommentQueue";
import { subscribeRecordSignal } from "./monitor/signalBus";
import {
  isRecordAccessEnded,
  RECORD_ACCESS_ENDED_REASONS,
  RECORD_ACCESS_REMOVED,
  RECORD_INVITE_CLOSED,
  RECORD_SYNC_ERROR_FALLBACK_COPY,
  type RecordSocketMode,
  recordSyncErrorCopy,
  useRecordSync,
} from "./useRecordSync";

const loadRecordParticipant = vi.fn();
const saveRecordParticipant = vi.fn();
const clearRecordParticipant = vi.fn();

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadRecordParticipant: (...args: unknown[]) => loadRecordParticipant(...args),
  saveRecordParticipant: (...args: unknown[]) => saveRecordParticipant(...args),
  clearRecordParticipant: (...args: unknown[]) =>
    clearRecordParticipant(...args),
}));

describe("useRecordSync", () => {
  beforeEach(() => {
    sessionStorage.clear();
    FakeWebSocket.reset();
    loadRecordParticipant.mockReset();
    saveRecordParticipant.mockReset();
    clearRecordParticipant.mockReset();
    loadRecordParticipant.mockResolvedValue(undefined);
    saveRecordParticipant.mockResolvedValue(undefined);
    clearRecordParticipant.mockResolvedValue(undefined);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resets instead of throwing on a corrupt record counter", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ now, toFake: ["Date"] });
    sessionStorage.setItem("record:tok-corrupt:client_seq", "41tail");
    renderHook(() => useRecordSync("tok-corrupt", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const join = JSON.parse(FakeWebSocket.instances[0]?.sent[0] || "{}");
    expect(join.command_type).toBe("Join");
    expect(join.client_seq).toBeGreaterThanOrEqual(now);
    expect(join.client_seq).not.toBe(41);
  });

  it("sends Join and caches the Echo lease", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    expect(JSON.parse(ws.sent[0] || "{}").command_type).toBe("Join");
    await act(async () => {
      ws.emit({
        type: "Echo",
        plane: "record",
        participant_id: "p_g",
        lease: "abc",
      });
      ws.emit({
        type: "Snapshot",
        plane: "record",
        snapshot: {
          session_id: "room1",
          state: "lobby",
          take_index: -1,
          participants: [
            {
              participant_id: "p_g",
              role: "guest",
              display_name: "Ava",
              connected: true,
              consented: null,
              muted: false,
              headphones_ack: false,
            },
          ],
          caps: { recorded: 4, producers: 2 },
        },
      });
    });
    expect(saveRecordParticipant).toHaveBeenCalledWith("tok", {
      participant_id: "p_g",
      lease: "abc",
    });
    expect(result.current.me?.display_name).toBe("Ava");
  });

  it("sends a segment report over the open socket and refuses without one", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    expect(result.current.send("SegmentReport", { take_index: 0 })).toBe(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    let sent = false;
    await act(async () => {
      sent = result.current.send("SegmentReport", {
        take_index: 0,
        segments: 2,
        final: true,
      });
    });
    expect(sent).toBe(true);
    const frame = JSON.parse(ws.sent[ws.sent.length - 1] || "{}");
    expect(frame.command_type).toBe("SegmentReport");
    expect(frame.payload).toEqual({ take_index: 0, segments: 2, final: true });
  });

  it("propagates a still-bound CLOSING socket refusal through Notes", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    const frameCount = ws.sent.length;
    ws.readyState = FakeWebSocket.CLOSING;

    expect(result.current.send("Comment", { body: "Still bound" })).toBe(false);
    expect(ws.sent).toHaveLength(frameCount);

    const key = commentsQueueKey("tok");
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      storageKey: string,
      value: string,
    ) {
      if (storageKey === key) {
        throw new Error("synthetic comments queue refusal");
      }
      originalSetItem(storageKey, value);
    });
    expect(
      postLiveComment(result.current.send, "tok", {
        body: "Retain this note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "guest",
      }),
    ).toBeNull();
    expect(ws.sent).toHaveLength(frameCount);
  });

  it("accepts Notes when either the queue or an open guest transport accepts", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    const frameCount = ws.sent.length;
    ws.readyState = FakeWebSocket.CLOSED;
    expect(
      postLiveComment(result.current.send, "tok-queued", {
        body: "Queued note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "guest",
      }),
    ).not.toBeNull();
    expect(ws.sent).toHaveLength(frameCount);

    ws.readyState = FakeWebSocket.OPEN;
    const key = commentsQueueKey("tok-transport");
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      storageKey: string,
      value: string,
    ) {
      if (storageKey === key) {
        throw new Error("synthetic comments queue refusal");
      }
      originalSetItem(storageKey, value);
    });
    expect(
      postLiveComment(result.current.send, "tok-transport", {
        body: "Transport accepted note",
        takeIndex: 2,
        recordingMs: 1200,
        author: "guest",
      }),
    ).not.toBeNull();
    expect(ws.sent).toHaveLength(frameCount + 1);
  });

  it("uses a name committed before the pending connection opens without reconnecting", async () => {
    FakeWebSocket.reset({ autoOpen: false });
    const { rerender } = renderHook(({ name }) => useRecordSync("tok", name), {
      initialProps: { name: "Ava" },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    rerender({ name: "Mira" });
    act(() => FakeWebSocket.instances[0].open());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
      command_type: "Join",
      payload: { display_name: "Mira" },
    });
  });

  it("resends cached participant ids on reconnect Join", async () => {
    loadRecordParticipant.mockResolvedValue({
      participant_id: "p_g",
      lease: "abc",
    });
    renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const payload = JSON.parse(FakeWebSocket.instances[0].sent[0] || "{}")
      .payload as { participant_id?: string; lease?: string };
    expect(payload.participant_id).toBe("p_g");
    expect(payload.lease).toBe("abc");
  });

  it("reconnects after lease_in_use", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const first = FakeWebSocket.instances[0];
      await act(async () => {
        first.emit({ type: "Error", code: "lease_in_use" });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a forbidden cached identity and stops reconnecting", async () => {
    vi.useFakeTimers();
    loadRecordParticipant.mockResolvedValue({
      participant_id: "p_g",
      lease: "stale",
    });
    try {
      const { unmount, result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const first = FakeWebSocket.instances[0];
      expect(
        JSON.parse(first.sent[0] || "{}").payload as { lease?: string },
      ).toMatchObject({ lease: "stale" });
      await act(async () => {
        first.emit({ type: "Error", code: "forbidden" });
      });
      expect(result.current.error).toBe("access_removed");
      expect(clearRecordParticipant).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
      unmount();
      renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const second = FakeWebSocket.instances[1];
      const payload = JSON.parse(second.sent[0] || "{}").payload as {
        lease?: string;
      };
      expect(payload.lease).toBe("stale");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an expired lease and rejoins with a new identity", async () => {
    vi.useFakeTimers();
    loadRecordParticipant.mockResolvedValue({
      participant_id: "p_g",
      lease: "expired",
    });
    try {
      const { result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Error",
          code: "invalid_lease",
        });
        await Promise.resolve();
      });
      expect(clearRecordParticipant).toHaveBeenCalledWith("tok");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      const retry = JSON.parse(FakeWebSocket.instances[1].sent[0] || "{}") as {
        payload: { participant_id?: string; lease?: string };
      };
      expect(retry.payload.participant_id).toBeUndefined();
      expect(retry.payload.lease).toBeUndefined();
      expect(result.current.error).not.toBe("access_removed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists the terminal access reasons", () => {
    expect(isRecordAccessEnded("access_removed")).toBe(true);
    expect(isRecordAccessEnded("invite_closed")).toBe(true);
    expect(isRecordAccessEnded("forbidden")).toBe(false);
    expect(isRecordAccessEnded(null)).toBe(false);
  });

  it("pins the access-ended reason wire strings", () => {
    expect(RECORD_INVITE_CLOSED).toBe("invite_closed");
    expect(RECORD_ACCESS_REMOVED).toBe("access_removed");
    expect([...RECORD_ACCESS_ENDED_REASONS]).toEqual([
      "access_removed",
      "invite_closed",
    ]);
  });

  it("keeps the invite_closed screen when the server then closes with 4403", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Error",
          code: "invite_closed",
        });
        FakeWebSocket.instances[0].close(4403);
      });
      expect(result.current.error).toBe("invite_closed");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never clears a cached identity on invite_closed", async () => {
    vi.useFakeTimers();
    loadRecordParticipant.mockResolvedValue({
      participant_id: "p_g",
      lease: "kept",
    });
    try {
      const { result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Error",
          code: "invite_closed",
        });
      });
      expect(result.current.error).toBe("invite_closed");
      expect(clearRecordParticipant).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends on invite_closed after an expired lease rejoins without it", async () => {
    vi.useFakeTimers();
    loadRecordParticipant.mockResolvedValue({
      participant_id: "p_g",
      lease: "expired",
    });
    try {
      const { result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].emit({
          type: "Error",
          code: "invalid_lease",
        });
        await Promise.resolve();
      });
      expect(clearRecordParticipant).toHaveBeenCalledWith("tok");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      const retry = JSON.parse(FakeWebSocket.instances[1].sent[0] || "{}") as {
        payload: { participant_id?: string; lease?: string };
      };
      expect(retry.payload.participant_id).toBeUndefined();
      expect(retry.payload.lease).toBeUndefined();
      await act(async () => {
        FakeWebSocket.instances[1].emit({
          type: "Error",
          code: "invite_closed",
        });
      });
      expect(result.current.error).toBe("invite_closed");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats removal close 4403 as terminal", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        FakeWebSocket.instances[0].close(4403);
      });
      expect(result.current.error).toBe("access_removed");
      expect(result.current.connected).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports disconnected and refuses sends once the hook is disabled", async () => {
    const { result, rerender } = renderHook(
      ({ mode }) => useRecordSync("tok", "Ava", mode),
      { initialProps: { mode: "join" as RecordSocketMode } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.connected).toBe(true);
    rerender({ mode: "off" });
    expect(result.current.connected).toBe(false);
    expect(result.current.send("Heartbeat")).toBe(false);
  });

  it("counts record frames per token under record:<token>:client_seq", async () => {
    sessionStorage.setItem("record:tok-seq:client_seq", "6");
    renderHook(() => useRecordSync("tok-seq", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const join = JSON.parse(FakeWebSocket.instances[0].sent[0] || "{}");
    expect(join.client_seq).toBe(7);
    expect(sessionStorage.getItem("record:tok-seq:client_seq")).toBe("7");
    expect(sessionStorage.getItem("record:tok:client_seq")).toBeNull();
  });

  it("persists Join client_seq across remounts", async () => {
    const { unmount } = renderHook(() => useRecordSync("tok-remount", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      JSON.parse(FakeWebSocket.instances[0].sent[0] || "{}").client_seq,
    ).toBe(1);
    unmount();
    renderHook(() => useRecordSync("tok-remount", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const second = FakeWebSocket.instances[1];
    expect(JSON.parse(second.sent[0] || "{}").client_seq).toBe(2);
  });

  it("emits inbound Signal frames on the record bus", async () => {
    const got: string[] = [];
    const stop = subscribeRecordSignal((msg) => {
      got.push(msg.to);
    });
    renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      FakeWebSocket.instances[0]?.emit({
        type: "Signal",
        plane: "record",
        from: "p_host",
        to: "p_g",
        description: { type: "offer", sdp: "v=0" },
      });
    });
    expect(got).toEqual(["p_g"]);
    stop();
  });
  it("maps record errors to guest copy without leaking prototype keys", () => {
    expect(recordSyncErrorCopy(null)).toBeNull();
    expect(recordSyncErrorCopy("room_full")).toBeNull();
    expect(recordSyncErrorCopy(RECORD_INVITE_CLOSED)).toBeNull();
    expect(recordSyncErrorCopy(RECORD_ACCESS_REMOVED)).toBeNull();
    expect(recordSyncErrorCopy("invalid_state")).toContain("current state");
    expect(recordSyncErrorCopy("constructor")).toBe(
      RECORD_SYNC_ERROR_FALLBACK_COPY,
    );
  });

  it("clearError drops a non-terminal error but keeps terminal ones", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    await act(async () => {
      ws.emit({ type: "Error", plane: "record", code: "rate_limited" });
    });
    expect(result.current.error).toBe("rate_limited");
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    await act(async () => {
      ws.emit({ type: "Error", plane: "record", code: RECORD_INVITE_CLOSED });
    });
    act(() => result.current.clearError());
    expect(result.current.error).toBe(RECORD_INVITE_CLOSED);
  });

  it("keeps room_full when a later non-terminal error arrives", async () => {
    const { result } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.instances[0];
    await act(async () => {
      ws.emit({ type: "Error", plane: "record", code: "room_full" });
    });
    await act(async () => {
      ws.emit({ type: "Error", plane: "record", code: "join_first" });
    });
    expect(result.current.error).toBe("room_full");
  });

  describe("snapshot ordering", () => {
    const snapshot = (state: string, serverTimeNs?: number) => ({
      type: "Snapshot",
      plane: "record",
      snapshot: {
        session_id: "room1",
        state,
        take_index: 0,
        participants: [],
        caps: { recorded: 4, producers: 2 },
        ...(serverTimeNs === undefined ? {} : { server_time_ns: serverTimeNs }),
      },
    });

    async function open() {
      const hook = renderHook(() => useRecordSync("tok", "Ava"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      return { ...hook, ws: FakeWebSocket.instances[0] };
    }

    it("keeps the held snapshot when an older one arrives later", async () => {
      const { result, ws } = await open();
      await act(async () => {
        ws.emit(snapshot("recording", 200));
        ws.emit(snapshot("lobby", 100));
      });
      expect(result.current.snapshot?.state).toBe("recording");
    });

    it("accepts a snapshot with the same timestamp", async () => {
      const { result, ws } = await open();
      await act(async () => {
        ws.emit(snapshot("lobby", 200));
        ws.emit(snapshot("recording", 200));
      });
      expect(result.current.snapshot?.state).toBe("recording");
    });

    it("drops a snapshot without a timestamp once a stamped one is held", async () => {
      const { result, ws } = await open();
      await act(async () => {
        ws.emit(snapshot("recording", 200));
        ws.emit(snapshot("lobby"));
      });
      expect(result.current.snapshot?.state).toBe("recording");
    });

    it("accepts a newer snapshot and a first one without a timestamp", async () => {
      const { result, ws } = await open();
      await act(async () => {
        ws.emit(snapshot("lobby"));
      });
      expect(result.current.snapshot?.state).toBe("lobby");
      await act(async () => {
        ws.emit(snapshot("recording", 300));
      });
      expect(result.current.snapshot?.state).toBe("recording");
    });
  });

  describe("looking in before the join", () => {
    const commands = (ws: FakeWebSocket) =>
      ws.sent.map(
        (raw) =>
          JSON.parse(raw) as { command_type?: string; payload?: unknown },
      );
    const settle = () =>
      act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    const lobby = (watchers: number, ns: number) => ({
      plane: "record",
      type: "Snapshot",
      snapshot: {
        session_id: "room1",
        state: "lobby",
        take_index: -1,
        participants: [],
        caps: { recorded: 4, producers: 2 },
        watchers,
        server_time_ns: ns,
      },
    });
    const watching = (mode: RecordSocketMode) =>
      renderHook(({ m }) => useRecordSync("tok", "Ava", m), {
        initialProps: { m: mode },
      });

    it("opens with observe and no name, and sends nothing, not even a Heartbeat", async () => {
      vi.useFakeTimers();
      watching("watch");
      await settle();
      const url = new URL(FakeWebSocket.instances[0].url);
      expect(url.searchParams.get("observe")).toBe("1");
      expect(url.searchParams.has("name")).toBe(false);
      expect(url.searchParams.has("client_id")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(FakeWebSocket.instances[0].sent).toEqual([]);
    });

    it("joins on the same socket when the mode turns to join, and beats only after the Echo", async () => {
      vi.useFakeTimers();
      loadRecordParticipant.mockResolvedValue({
        participant_id: "p_prod",
        lease: "kept",
      });
      const hook = watching("watch");
      await settle();
      const ws = FakeWebSocket.instances[0];
      hook.rerender({ m: "join" });
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(commands(ws)).toEqual([
        expect.objectContaining({
          command_type: "Join",
          payload: {
            display_name: "Ava",
            participant_id: "p_prod",
            lease: "kept",
          },
        }),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(commands(ws)).toHaveLength(1);
      await act(async () => {
        ws.emit({
          plane: "record",
          type: "Echo",
          participant_id: "p_prod",
          lease: "kept",
        });
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(commands(ws).map((c) => c.command_type)).toEqual([
        "Join",
        "Heartbeat",
      ]);
    });

    it("sends the Join on open when the mode turns to join while still connecting", async () => {
      FakeWebSocket.reset({ autoOpen: false });
      const hook = watching("watch");
      await settle();
      const ws = FakeWebSocket.instances[0];
      hook.rerender({ m: "join" });
      expect(ws.sent).toEqual([]);
      await act(async () => {
        ws.open();
      });
      expect(commands(ws).map((c) => c.command_type)).toEqual(["Join"]);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    describe("a look refused with 4403", () => {
      const held = { participant_id: "p_prod", lease: "kept" };

      it("is access ended when no lease is cached", async () => {
        vi.useFakeTimers();
        const hook = watching("watch");
        await settle();
        await act(async () => {
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBe("access_removed");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
      });

      it("only ends the look when a lease is cached, then Join carries the lease", async () => {
        vi.useFakeTimers();
        loadRecordParticipant.mockResolvedValue(held);
        const hook = watching("watch");
        await settle();
        await act(async () => {
          FakeWebSocket.instances[0].open();
          FakeWebSocket.instances[0].emit(lobby(1, 10));
        });
        await act(async () => {
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBeNull();
        expect(hook.result.current.snapshot).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
        hook.rerender({ m: "join" });
        await settle();
        expect(FakeWebSocket.instances).toHaveLength(2);
        const joining = FakeWebSocket.instances[1];
        expect(new URL(joining.url).searchParams.has("observe")).toBe(false);
        await act(async () => {
          joining.open();
        });
        expect(commands(joining)[0]).toMatchObject({
          command_type: "Join",
          payload: expect.objectContaining(held),
        });
        await act(async () => {
          joining.close(4403);
        });
        expect(hook.result.current.error).toBe("access_removed");
      });

      const closedFrame = {
        plane: "record",
        type: "Error",
        code: "invite_closed",
      };

      it("shows the invite closed screen when the look is told so and no lease is cached", async () => {
        vi.useFakeTimers();
        const hook = watching("watch");
        await settle();
        await act(async () => {
          FakeWebSocket.instances[0].emit(closedFrame);
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBe(RECORD_INVITE_CLOSED);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
      });

      it("ignores that frame on a look when a lease is cached, so the look only stops", async () => {
        vi.useFakeTimers();
        loadRecordParticipant.mockResolvedValue(held);
        const hook = watching("watch");
        await settle();
        await act(async () => {
          FakeWebSocket.instances[0].emit(closedFrame);
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBeNull();
        hook.rerender({ m: "join" });
        await settle();
        expect(FakeWebSocket.instances).toHaveLength(2);
      });

      it("ends access when the 4403 comes after the Join was answered on the same socket", async () => {
        vi.useFakeTimers();
        loadRecordParticipant.mockResolvedValue(held);
        const hook = watching("watch");
        await settle();
        hook.rerender({ m: "join" });
        await act(async () => {
          FakeWebSocket.instances[0].emit({
            plane: "record",
            type: "Echo",
            participant_id: "p_prod",
            lease: "kept",
          });
        });
        await act(async () => {
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBe("access_removed");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
      });

      it("lets the press that came first retry as a join", async () => {
        vi.useFakeTimers();
        loadRecordParticipant.mockResolvedValue(held);
        const hook = watching("watch");
        await settle();
        hook.rerender({ m: "join" });
        await act(async () => {
          FakeWebSocket.instances[0].close(4403);
        });
        expect(hook.result.current.error).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(
          new URL(FakeWebSocket.instances[1].url).searchParams.has("observe"),
        ).toBe(false);
      });
    });

    it("opens a joining socket at once when the mode turns to join during a backoff", async () => {
      vi.useFakeTimers();
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].close(4429);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
      hook.rerender({ m: "join" });
      await settle();
      expect(FakeWebSocket.instances).toHaveLength(2);
      const joining = FakeWebSocket.instances[1];
      expect(new URL(joining.url).searchParams.has("observe")).toBe(false);
      expect(commands(joining).map((c) => c.command_type)).toEqual(["Join"]);
    });

    it("keeps looking on a reconnect, and joins with the lease on one after the press", async () => {
      vi.useFakeTimers();
      loadRecordParticipant.mockResolvedValue({
        participant_id: "p_prod",
        lease: "kept",
      });
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
        await vi.advanceTimersByTimeAsync(1000);
      });
      const again = FakeWebSocket.instances[1];
      expect(new URL(again.url).searchParams.get("observe")).toBe("1");
      expect(again.sent).toEqual([]);
      hook.rerender({ m: "join" });
      await act(async () => {
        again.close(1006);
        await vi.advanceTimersByTimeAsync(1000);
      });
      const joined = FakeWebSocket.instances.at(-1);
      expect(new URL(joined?.url ?? "").searchParams.has("observe")).toBe(
        false,
      );
      expect(commands(joined as FakeWebSocket)[0]).toMatchObject({
        command_type: "Join",
        payload: { participant_id: "p_prod", lease: "kept" },
      });
    });

    it("counts the first snapshot of a look as a healthy connection", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      await act(async () => {
        FakeWebSocket.instances[1].emit(lobby(1, 10));
        FakeWebSocket.instances[1].close(1006);
        await vi.advanceTimersByTimeAsync(480);
      });
      expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it("clears the snapshot and closes the socket when the look ends", async () => {
      const hook = watching("watch");
      await settle();
      const ws = FakeWebSocket.instances[0];
      await act(async () => {
        ws.emit(lobby(1, 10));
      });
      expect(hook.result.current.snapshot?.watchers).toBe(1);
      hook.rerender({ m: "off" });
      expect(hook.result.current.snapshot).toBeNull();
      expect(hook.result.current.connected).toBe(false);
      expect(ws.closed).toBe(true);
    });

    it("joins again on the same socket after a failed Join sent the mode back to watch", async () => {
      const hook = watching("watch");
      await settle();
      const ws = FakeWebSocket.instances[0];
      hook.rerender({ m: "join" });
      hook.rerender({ m: "watch" });
      hook.rerender({ m: "join" });
      expect(commands(ws).map((c) => c.command_type)).toEqual(["Join", "Join"]);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("drops the room it showed when a look closes, and counts nothing until the next socket's first snapshot", async () => {
      vi.useFakeTimers();
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].emit(lobby(1, 10));
      });
      expect(hook.result.current.snapshot?.watchers).toBe(1);
      expect(hook.result.current.counted).toBe(true);
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
      });
      expect(hook.result.current.snapshot).toBeNull();
      expect(hook.result.current.counted).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(hook.result.current.connected).toBe(true);
      expect(hook.result.current.snapshot).toBeNull();
      expect(hook.result.current.counted).toBe(false);
      await act(async () => {
        FakeWebSocket.instances[1].close(4429);
      });
      expect(hook.result.current.snapshot).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
        FakeWebSocket.instances.at(-1)?.emit(lobby(2, 20));
      });
      expect(hook.result.current.counted).toBe(true);
      expect(hook.result.current.snapshot?.watchers).toBe(2);
    });

    it("stops counting the page as counted when the look ends by choice", async () => {
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].emit(lobby(1, 10));
      });
      expect(hook.result.current.counted).toBe(true);
      hook.rerender({ m: "off" });
      expect(hook.result.current.counted).toBe(false);
    });

    it("keeps the room it showed when a socket that was asked to join closes before the Echo", async () => {
      vi.useFakeTimers();
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].emit(lobby(1, 10));
      });
      hook.rerender({ m: "join" });
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
      });
      expect(hook.result.current.snapshot?.watchers).toBe(1);
      expect(hook.result.current.counted).toBe(false);
    });

    it("drops the kept room and opens a look again when the mode returns to watch on a joining socket", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const hook = watching("watch");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].emit(lobby(1, 10));
      });
      hook.rerender({ m: "join" });
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
      });
      expect(hook.result.current.snapshot).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      hook.rerender({ m: "watch" });
      await settle();
      expect(hook.result.current.snapshot).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(3);
      expect(
        new URL(FakeWebSocket.instances[2].url).searchParams.get("observe"),
      ).toBe("1");
    });

    it("retries a press made while connecting at once when the server then refuses the look", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      FakeWebSocket.reset({ autoOpen: false });
      const hook = watching("watch");
      await settle();
      const first = FakeWebSocket.instances[0];
      hook.rerender({ m: "join" });
      await act(async () => {
        first.open();
        first.close(4429);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(
        new URL(FakeWebSocket.instances[1].url).searchParams.has("observe"),
      ).toBe(false);
    });

    it("does not hurry a guest's reconnect after an early close", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      watching("join");
      await settle();
      await act(async () => {
        FakeWebSocket.instances[0].close(1006);
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("stops looking for good on a full room", async () => {
      const hook = watching("watch");
      await settle();
      const ws = FakeWebSocket.instances[0];
      await act(async () => {
        ws.emit({ plane: "record", type: "Error", code: "room_full" });
      });
      expect(hook.result.current.error).toBe("room_full");
      expect(ws.closed).toBe(true);
    });
  });
});
