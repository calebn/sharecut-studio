import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHostSync } from "../../hooks/useHostSync";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { FakeWebSocket } from "../../test/fakeWebSocket";
import {
  minimalProject,
  recordParticipant,
  recordSnapshot,
} from "../../test/fixtures";
import { useRecordHostStore } from "../hostStore";
import { useGuestRoom } from "../useGuestRoom";
import { useHostKeeperCapture } from "../useHostKeeperCapture";
import { openKeeperTap } from "./graph";
import { KeeperSession } from "./session";
import {
  createOpfsSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  parseKeeperMeta,
} from "./store";

const graph = vi.hoisted(() => ({ emit: (_pcm: Float32Array) => {} }));
vi.mock("./graph", () => ({
  openKeeperTap: vi.fn(
    async (
      _stream: MediaStream,
      onPcm: (pcm: Float32Array, rate: number) => void,
    ) => {
      graph.emit = (pcm) => onPcm(pcm, 48_000);
      return { stop: vi.fn(), resume: async () => "running" as const };
    },
  ),
}));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  createOpfsSink: vi.fn(),
}));
vi.mock("../../desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: () => undefined,
}));
vi.mock("../monitor/useRecordMonitor", () => ({
  useRecordMonitor: () => ({
    hearing: false,
    remoteCount: 0,
    error: null,
    levels: {},
    outputSupported: false,
    setSinkId: async () => false,
  }),
}));
vi.mock("../../services/offlineQueue/offlineStore", () => ({
  loadRecordParticipant: async () => undefined,
  saveRecordParticipant: async () => undefined,
  clearRecordParticipant: async () => undefined,
}));
vi.mock("../../services/offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
}));
vi.mock("../../api", () => ({
  loadSessionMeta: async () => ({ mtime_ns: 0, exists: false }),
  loadSessionState: async () => null,
  postSessionState: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  localStorage.clear();
  sessionStorage.clear();
  useDawStore
    .getState()
    .hydrate("/tmp/keeper-ingress.sharecut", minimalProject());
  useRecordHostStore.getState().setSnapshot(null);
  useRecordHostStore.getState().setKeeperStorage(null, null);
  vi.mocked(createOpfsSink).mockReset();
  vi.mocked(openKeeperTap).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ["host", 1000, "none"],
  ["host", 2000, "none"],
  ["guest", 1000, "none"],
  ["guest", 2000, "none"],
  ["host", 1000, "same"],
  ["host", 1000, "aba"],
] as const)(
  "captures through the actual %s caller after first observation%d /identity%s",
  async (producer, observedAt, identity) => {
    const commits = vi.fn<ProfilerOnRenderCallback>();
    const readPerformance = vi.spyOn(performance, "now").mockReturnValue(1000);
    const scanEntered = deferred();
    const scanRelease = deferred();
    const storageRelease = deferred<MemorySink>();
    class HeldSink extends MemorySink {
      override async nextSegmentIndex(
        sessionId: string,
        takeIndex: number,
        participantId: string,
      ) {
        scanEntered.resolve();
        if (producer === "host") await scanRelease.promise;
        return super.nextSegmentIndex(sessionId, takeIndex, participantId);
      }
    }
    const sink = new HeldSink();
    vi.mocked(createOpfsSink).mockReturnValue(storageRelease.promise);
    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
      }),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              mode: "record",
              kind: "record",
              token: "clock-token",
              role: "guest",
              session_id: "clock-room",
              capabilities: ["join"],
              episode: { name: "Clock episode" },
              room: { recorded_cap: 4, producer_cap: 2 },
              build: { capture: true, monitor: false, upload: false },
              expires_at: null,
            }),
            { status: 200 },
          ),
      ),
    );
    const participantId = producer === "host" ? "p_host" : "p_g";
    const person = recordParticipant({
      participant_id: participantId,
      role: producer,
      display_name: "Guest",
      connected: true,
      consented: true,
      muted: false,
      headphones_ack: true,
    });
    const timestamped = identity === "none";
    const snapshot = recordSnapshot({
      session_id: "clock-room",
      state: "recording",
      take_index: 0,
      recording_ms: 300,
      server_time_ns: timestamped ? 1_000_000_000 : undefined,
      participants: [person],
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 700,
          session_start_iso: "1970-01-01T00:00:00.700Z",
          pauses: [],
          consented_participant_ids: [participantId],
          segment_reports: {},
        },
      ],
    });
    const lobby = {
      ...snapshot,
      state: "lobby" as const,
      take_index: -1,
      recording_ms: 0,
      takes: [],
      server_time_ns: timestamped ? 0 : undefined,
    };
    const apply = vi.spyOn(KeeperSession.prototype, "apply");
    if (producer === "host")
      useRecordHostStore.getState().setKeeperStorage(sink, null);
    const host =
      producer === "host"
        ? renderHook(
            () => {
              const current = useDawStore();
              useHostSync(
                current.projectPath,
                current.applyAgentSession,
                () => ({}),
                true,
                current.lastAppliedRevision,
                current.lastAppliedCommandId,
                false,
                "keeper-ingress",
              );
              return useHostKeeperCapture();
            },
            {
              wrapper: ({ children }: { children: ReactNode }) => (
                <Profiler id="host-keeper" onRender={commits}>
                  {children}
                </Profiler>
              ),
            },
          )
        : null;
    const guest =
      producer === "guest"
        ? renderHook(() => useGuestRoom("clock-token"))
        : null;
    if (guest)
      await waitFor(() =>
        expect(guest.result.current.bootstrap?.build.capture).toBe(true),
      );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      if (guest)
        socket.emit({
          plane: "record",
          type: "Echo",
          participant_id: participantId,
          lease: "clock-lease",
        });
      socket.emit({ plane: "record", type: "Snapshot", snapshot: lobby });
    });
    if (guest) {
      expect(guest.result.current.me).toMatchObject({
        participant_id: participantId,
        consented: true,
        role: "guest",
      });
      expect(guest.result.current.sink).toBeNull();
      await act(async () => guest.result.current.mic.request());
      await waitFor(() => expect(guest.result.current.mic.stream).toBe(stream));
    } else
      await waitFor(() => expect(host?.result.current.stream).toBe(stream));
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    const unsubscribe =
      producer === "host"
        ? useRecordHostStore.subscribe((next, previous) => {
            if (
              next.snapshot?.state === "recording" &&
              next.snapshot !== previous.snapshot
            ) {
              expect(Date.now()).toBe(1000);
              vi.setSystemTime(observedAt);
              readPerformance.mockReturnValue(observedAt);
            }
          })
        : () => {};
    await act(async () => {
      socket.emit({ plane: "record", type: "Snapshot", snapshot });
      if (guest) {
        expect(guest.result.current.snapshot?.state).toBe("lobby");
        vi.setSystemTime(observedAt);
        readPerformance.mockReturnValue(observedAt);
      }
    });
    unsubscribe();
    const accepted =
      host?.result.current.snapshot ?? guest?.result.current.snapshot;
    expect(accepted).toMatchObject({
      state: "recording",
      participants: [person],
    });
    expect(accepted?.takes?.[0].consented_participant_ids).toEqual([
      participantId,
    ]);
    if (host) {
      await scanEntered.promise;
      expect(host.result.current.recordingLocally).toBe(false);
      expect(useRecordHostStore.getState().receivedAtMs).toBe(1000);
      const beforeUnrelated = commits.mock.calls.length;
      act(() => useRecordHostStore.getState().setCaptureHealth("pending"));
      expect(commits).toHaveBeenCalledTimes(beforeUnrelated);
    } else expect(guest?.result.current.sink).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    if (host && identity !== "none") {
      vi.setSystemTime(2000);
      readPerformance.mockReturnValue(2000);
      const beforeSameIdentity = commits.mock.calls.length;
      await act(async () =>
        useRecordHostStore
          .getState()
          .setSnapshot(identity === "same" ? accepted! : { ...accepted! }),
      );
      expect(useRecordHostStore.getState().receivedAtMs).toBe(2000);
      if (identity === "same")
        expect(commits).toHaveBeenCalledTimes(beforeSameIdentity);
      if (identity === "aba") {
        vi.setSystemTime(3000);
        readPerformance.mockReturnValue(3000);
        await act(async () =>
          useRecordHostStore.getState().setSnapshot(accepted!),
        );
        expect(useRecordHostStore.getState().receivedAtMs).toBe(3000);
      }
      expect(useRecordHostStore.getState().snapshot).toBe(accepted);
    }
    vi.setSystemTime(5000);
    readPerformance.mockReturnValue(5000);
    await act(async () => {
      if (host) scanRelease.resolve();
      else storageRelease.resolve(sink);
    });
    await waitFor(() =>
      expect(
        host?.result.current.recordingLocally ??
          guest?.result.current.keeper.recordingLocally,
      ).toBe(true),
    );
    await act(async () => graph.emit(new Float32Array(480).fill(0.1)));
    const path = keeperWavPath({
      sessionId: "clock-room",
      participantId,
      takeIndex: 0,
      segmentIndex: 0,
    });
    await waitFor(() =>
      expect((sink.files.get(path)?.length ?? 0) > 44).toBe(true),
    );
    if (identity === "none") {
      const beforeHeartbeat = apply.mock.calls.length;
      const beforeTap = vi.mocked(openKeeperTap).mock.calls.length;
      const current =
        host?.result.current.snapshot ?? guest?.result.current.snapshot;
      await act(async () =>
        socket.emit({
          plane: "record",
          type: "Snapshot",
          snapshot: {
            ...current!,
            recording_ms: 4300,
            server_time_ns: 5_000_000_000,
          },
        }),
      );
      expect(apply).toHaveBeenCalledTimes(beforeHeartbeat);
      expect(openKeeperTap).toHaveBeenCalledTimes(beforeTap);
    }
    const recordingGates = apply.mock.calls.filter(
      ([gate]) => gate.roomState === "recording",
    );
    const current =
      host?.result.current.snapshot ?? guest?.result.current.snapshot;
    const stopped = {
      ...current!,
      state: "stopped" as const,
      recording_ms: 0,
      server_time_ns: timestamped ? 6_000_000_000 : undefined,
    };
    vi.setSystemTime(6000);
    readPerformance.mockReturnValue(6000);
    await act(async () =>
      socket.emit({ plane: "record", type: "Snapshot", snapshot: stopped }),
    );
    await waitFor(async () =>
      expect(
        parseKeeperMeta(await sink.read(keeperMetaPath(path)))?.complete,
      ).toBe(true),
    );
    const metadata = parseKeeperMeta(await sink.read(keeperMetaPath(path)));
    const expected = identity === "aba" ? 2300 : 4300;
    expect(recordingGates.length).toBeGreaterThan(0);
    expect
      .soft(recordingGates.map(([gate]) => gate.recordingMs))
      .toEqual(Array.from({ length: recordingGates.length }, () => expected));
    expect.soft(metadata).toMatchObject({
      sessionId: "clock-room",
      participantId,
      takeIndex: 0,
      segmentIndex: 0,
      joinOffsetMs: expected,
      complete: true,
    });
    expect(track.stop).not.toHaveBeenCalled();
  },
);
