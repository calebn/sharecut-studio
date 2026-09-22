import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import { bindRecordHostSend } from "./hostWire";
import type { RecordSnapshot } from "./types";
import { useHostKeeperCapture } from "./useHostKeeperCapture";

const mic = vi.hoisted(() =>
  vi.fn((_enabled: boolean, _deviceId: string, _resetKey = 0) => ({
    stream: null as MediaStream | null,
    devices: [],
    error: null as string | null,
    errorName: null as string | null,
    settingsWarning: null,
    pending: false,
    lost: false,
    retry: vi.fn(),
  })),
);

const keeper = vi.hoisted(() =>
  vi.fn(
    (args: {
      resetKey?: number;
      enabled: boolean;
      onActivity?: () => void;
    }) => ({
      error: null as string | null,
      recordingLocally: args.enabled,
    }),
  ),
);

vi.mock("./useMicStream", () => ({
  useMicStream: (...args: unknown[]) =>
    mic(...(args as [boolean, string, number])),
}));

vi.mock("./keeper/useKeeperCapture", () => ({
  useKeeperCapture: (args: { resetKey?: number; enabled: boolean }) =>
    keeper(args),
}));

const recording: RecordSnapshot = {
  session_id: "room1",
  state: "recording",
  take_index: 0,
  participants: [
    {
      participant_id: "p_host",
      role: "host",
      display_name: "Host",
      connected: true,
      consented: true,
      muted: false,
      headphones_ack: true,
    },
  ],
  caps: { recorded: 4, producers: 2 },
};

describe("useHostKeeperCapture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mic.mockClear();
    keeper.mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useRecordHostStore.getState().setSnapshot(recording);
    useRecordHostStore.getState().setConnected(false);
    bindRecordHostSend(null);
  });

  it("rearms keeper heartbeats after five seconds and retries an unbound send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    const sent: Record<string, unknown>[] = [];
    renderHook(() => useHostKeeperCapture());
    const onActivity = keeper.mock.calls.at(-1)?.[0].onActivity;
    expect(onActivity).toBeTypeOf("function");
    onActivity?.();
    expect(sent).toHaveLength(0);
    bindRecordHostSend((frame) => sent.push(frame));
    onActivity?.();
    onActivity?.();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command_type).toBe("Heartbeat");
    await act(async () => vi.advanceTimersByTime(4_999));
    onActivity?.();
    expect(sent).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    onActivity?.();
    expect(sent).toHaveLength(2);
  });

  it("keeps the activity cadence when the wall clock moves backward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    const onActivity = keeper.mock.calls.at(-1)?.[0].onActivity;
    onActivity?.();
    vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
    await act(async () => vi.advanceTimersByTime(5_000));
    onActivity?.();
    expect(sent).toHaveLength(2);
  });

  it("uses a timer while the host is paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    useRecordHostStore
      .getState()
      .setSnapshot({ ...recording, state: "paused" });
    keeper.mockReturnValueOnce({ error: null, recordingLocally: false });
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command_type).toBe("Heartbeat");
  });

  it("does not send fallback heartbeats after the room stops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    useRecordHostStore
      .getState()
      .setSnapshot({ ...recording, state: "stopped" });
    keeper.mockReturnValueOnce({ error: null, recordingLocally: false });
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });

  it("does not send fallback heartbeats while the REC keeper initializes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    mic.mockReturnValueOnce({
      stream: {} as MediaStream,
      devices: [],
      error: null,
      errorName: null,
      settingsWarning: null,
      pending: false,
      lost: false,
      retry: vi.fn(),
    });
    keeper.mockReturnValueOnce({ error: null, recordingLocally: false });
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });

  it("does not send fallback heartbeats before REC microphone capture starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    keeper.mockReturnValueOnce({ error: null, recordingLocally: false });
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });

  it("does not send fallback heartbeats during a failed active take", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    keeper.mockReturnValueOnce({ error: "disk full", recordingLocally: false });
    useRecordHostStore.getState().setConnected(true);
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });

  it("does not send fallback heartbeats after the microphone track ends during REC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    mic.mockReturnValueOnce({
      stream: null,
      devices: [],
      error: null,
      errorName: null,
      settingsWarning: null,
      pending: false,
      lost: true,
      retry: vi.fn(),
    });
    keeper.mockReturnValueOnce({ error: null, recordingLocally: false });
    const sent: Record<string, unknown>[] = [];
    bindRecordHostSend((frame) => sent.push(frame));
    renderHook(() => useHostKeeperCapture());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(sent).toHaveLength(0);
  });

  it("reports a denied reconnect after a live microphone track is lost", () => {
    mic.mockReturnValueOnce({
      stream: null,
      devices: [],
      error: "Permission denied",
      errorName: "NotAllowedError",
      settingsWarning: null,
      pending: false,
      lost: true,
      retry: vi.fn(),
    });
    const { result } = renderHook(() => useHostKeeperCapture());
    expect(result.current.micLost).toBe(true);
    expect(result.current.micStatus).toBe("denied");
  });

  it("keeps the same keeper resetKey across a sub-10s WS blip", () => {
    const { rerender } = renderHook(() => useHostKeeperCapture());
    expect(mic).toHaveBeenLastCalledWith(true, "", 0);
    expect(keeper.mock.calls.at(-1)?.[0].resetKey).toBe(0);
    useRecordHostStore.getState().setConnected(true);
    rerender();
    expect(mic).toHaveBeenLastCalledWith(true, "", 0);
    expect(keeper.mock.calls.at(-1)?.[0].resetKey).toBe(0);
    expect(keeper.mock.calls.at(-1)?.[0].enabled).toBe(true);
  });

  it("re-arms mic and keeper on an open host-reconnect pause", () => {
    useRecordHostStore.getState().setSnapshot({
      ...recording,
      state: "paused",
      pause_reason: "host_reconnect",
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 0,
          session_start_iso: "t0",
          pauses: [
            {
              seq: 2,
              pause_wall_ms: 20_000,
              resume_wall_ms: null,
              pause_reason: "host_reconnect",
            },
          ],
        },
      ],
    });
    renderHook(() => useHostKeeperCapture());
    expect(mic).toHaveBeenLastCalledWith(true, "", 3);
    expect(keeper.mock.calls.at(-1)?.[0].resetKey).toBe(3);
  });

  it("exposes denied microphone guidance and reuses the mic retry hook", () => {
    const retry = vi.fn();
    mic.mockReturnValueOnce({
      stream: null,
      devices: [],
      error: "permission blocked",
      errorName: "NotAllowedError",
      settingsWarning: null,
      pending: false,
      lost: false,
      retry,
    });
    const { result } = renderHook(() => useHostKeeperCapture());

    expect(result.current.micStatus).toBe("denied");
    expect(result.current.micError).toBe("permission blocked");
    act(() => result.current.retryMic());
    expect(retry).toHaveBeenCalledOnce();
    expect(keeper.mock.calls.at(-1)?.[0].resetKey).toBe(0);
  });
});
