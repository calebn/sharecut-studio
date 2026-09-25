import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeRecordSignal } from "./monitor/signalBus";
import {
  isRecordAccessEnded,
  RECORD_ACCESS_ENDED_REASONS,
  RECORD_ACCESS_REMOVED,
  RECORD_INVITE_CLOSED,
  useRecordSync,
} from "./useRecordSync";

const loadRecordParticipant = vi.fn();
const saveRecordParticipant = vi.fn();
const clearRecordParticipant = vi.fn();

vi.mock("../state/offlineStore", () => ({
  loadRecordParticipant: (...args: unknown[]) => loadRecordParticipant(...args),
  saveRecordParticipant: (...args: unknown[]) => saveRecordParticipant(...args),
  clearRecordParticipant: (...args: unknown[]) =>
    clearRecordParticipant(...args),
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
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

  close(code = 1000) {
    this.onclose?.({ code });
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("useRecordSync", () => {
  beforeEach(() => {
    sessionStorage.clear();
    FakeWebSocket.instances = [];
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

  it("persists Join client_seq across remounts", async () => {
    const { unmount } = renderHook(() => useRecordSync("tok", "Ava"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      JSON.parse(FakeWebSocket.instances[0].sent[0] || "{}").client_seq,
    ).toBe(1);
    unmount();
    renderHook(() => useRecordSync("tok", "Ava"));
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
});
