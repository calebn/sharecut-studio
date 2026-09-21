import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import type { RecordSnapshot } from "./types";
import { useHostKeeperCapture } from "./useHostKeeperCapture";

const mic = vi.hoisted(() =>
  vi.fn((_enabled: boolean, _deviceId: string, _resetKey = 0) => ({
    stream: null,
    devices: [],
    error: null,
    settingsWarning: null,
    lost: false,
    retry: vi.fn(),
  })),
);

const keeper = vi.hoisted(() =>
  vi.fn((args: { resetKey?: number; enabled: boolean }) => ({
    error: null,
    recordingLocally: args.enabled,
  })),
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
  beforeEach(() => {
    mic.mockClear();
    keeper.mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useRecordHostStore.getState().setSnapshot(recording);
    useRecordHostStore.getState().setConnected(false);
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
});
