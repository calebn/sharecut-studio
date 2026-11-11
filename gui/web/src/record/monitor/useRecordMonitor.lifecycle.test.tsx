import { act, renderHook } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import type { RecordSnapshot } from "../types";
import { OUTPUT_KEY, useOutputDevice } from "../useOutputDevice";
import type { RecordMeshOpts } from "./mesh";
import { emitRecordSignal } from "./signalBus";
import { useRecordMonitor } from "./useRecordMonitor";

type GraphProbe = {
  dispose: ReturnType<typeof vi.fn>;
  removeRemote: ReturnType<typeof vi.fn>;
};
type ContextProbe = {
  picks: string[];
  close: ReturnType<typeof vi.fn>;
  createMediaStreamSource: ReturnType<typeof vi.fn>;
};
const fixture = vi.hoisted(() => ({
  supported: true,
  meshes: [] as RecordMeshOpts[],
  graphs: [] as GraphProbe[],
  contexts: [] as ContextProbe[],
  peaks: new Map<string, number>(),
  tapRead: vi.fn(),
  signal: vi.fn<() => Promise<void>>(),
}));

vi.mock("./mesh", () => ({
  RecordMesh: class {
    constructor(options: RecordMeshOpts) {
      fixture.meshes.push(options);
    }
    dispose() {}
    syncPeers() {}
    setLocalStream() {}
    setSendEnabled() {}
    handleSignal() {
      return fixture.signal();
    }
  },
}));
vi.mock("../../audio/mixMinus", () => ({
  MIX_MINUS_RAMP_S: 0,
  MixMinusGraph: class {
    dispose = vi.fn();
    removeRemote = vi.fn();
    constructor() {
      fixture.graphs.push(this);
    }
    addRemote() {}
    setRemoteMuted() {}
    disconnectLocal() {}
    connectLocal() {}
  },
}));
vi.mock("./peerLevels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./peerLevels")>()),
  createPeerLevelTap: (_context: unknown, source: { id: string }) => ({
    read: () => {
      fixture.tapRead(source.id);
      return fixture.peaks.get(source.id) ?? 0;
    },
    dispose() {},
  }),
}));
class FakeContext {
  picks: string[] = [];
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn((stream: MediaStream) => ({
    id: stream.id,
    disconnect: vi.fn(),
  }));
  constructor() {
    fixture.contexts.push(this);
  }
  async resume() {}
  async setSinkId(id: string) {
    this.picks.push(id);
  }
}
vi.mock("../../utils/audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/audio")>()),
  audioContextCtor: () => (fixture.supported ? FakeContext : undefined),
}));

type Args = Parameters<typeof useRecordMonitor>[0];
type Monitor = ReturnType<typeof useRecordMonitor>;
function room(session = "room"): RecordSnapshot {
  return {
    session_id: session,
    state: "lobby",
    take_index: 0,
    caps: { recorded: 4, producers: 2 },
    participants: [
      {
        participant_id: "peer",
        role: "guest",
        display_name: "Ava",
        connected: true,
        consented: true,
        muted: false,
        headphones_ack: true,
      },
    ],
  };
}
function args(): Args {
  return {
    enabled: true,
    localId: "me",
    role: "guest",
    snapshot: room(),
    localStream: null,
    muted: false,
    send: vi.fn(),
  };
}
function stream(id: string): MediaStream {
  return { id } as MediaStream;
}
function track(id: string, index = fixture.meshes.length - 1) {
  act(() => fixture.meshes[index]!.onRemoteTrack("peer", stream(id)));
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
beforeEach(() => {
  vi.useFakeTimers();
  fixture.supported = true;
  fixture.meshes.length = 0;
  fixture.graphs.length = 0;
  fixture.contexts.length = 0;
  fixture.peaks.clear();
  fixture.tapRead.mockClear();
  fixture.signal.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  if (originalMediaDevices)
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("monitor resource original lifecycle", () => {
  it("retains peer feedback in disable layout, then clears feedback but keeps error and generation", async () => {
    const initial = args();
    const seen: { input: Args; monitor: Monitor }[] = [];
    const { result, rerender, unmount } = renderHook(
      (input: Args) => {
        const monitor = useRecordMonitor(input);
        useLayoutEffect(() => {
          seen.push({ input, monitor });
        });
        return monitor;
      },
      { initialProps: initial },
    );
    fixture.peaks.set("old", 0.5);
    track("old");
    await tick(100);
    act(() => fixture.meshes[0]!.onError?.(new Error("Sticky original error")));
    expect(result.current.levels).toEqual({ peer: 0.5 });
    expect(result.current.remoteCount).toBe(1);
    expect(result.current.contextGeneration).toBe(1);
    const held = result.current;
    const disabled = { ...initial, enabled: false };
    rerender(disabled);
    expect(
      seen.find((row) => row.input === disabled)?.monitor.remoteCount,
    ).toBe(1);
    expect(seen.find((row) => row.input === disabled)?.monitor.levels).toBe(
      held.levels,
    );
    expect(result.current.remoteCount).toBe(0);
    expect(result.current.levels).toEqual({});
    expect(result.current.error).toBe("Sticky original error");
    expect(result.current.contextGeneration).toBe(1);
    expect(fixture.contexts[0]!.close).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each(["localId", "role", "session"] as const)(
    "preserves the live count-owned meter deadline through an active %s replacement",
    async (key) => {
      const initial = args();
      const { result, rerender, unmount } = renderHook(
        (input: Args) => useRecordMonitor(input),
        { initialProps: initial },
      );
      fixture.peaks.set("old", 0.5);
      track("old");
      await tick(100);
      const levels = result.current.levels;
      await tick(40);
      rerender({
        ...initial,
        ...(key === "localId"
          ? { localId: "replacement" }
          : key === "role"
            ? { role: "producer" as const }
            : { snapshot: room("next-room") }),
      });
      expect(fixture.contexts).toHaveLength(2);
      expect(fixture.contexts[0]!.close).toHaveBeenCalledTimes(1);
      expect(result.current.remoteCount).toBe(1);
      expect(result.current.levels).toBe(levels);
      expect(result.current.contextGeneration).toBe(2);
      fixture.peaks.set("new", 0.8);
      track("new");
      expect(result.current.levels).toBe(levels);
      await tick(59);
      expect(result.current.levels).toBe(levels);
      await tick(1);
      expect(result.current.levels).toEqual({ peer: 0.8 });
      expect(fixture.tapRead).toHaveBeenLastCalledWith("new");
      unmount();
    },
  );

  it("retains old error acceptance while rejecting tracks from the retired acquisition", () => {
    const initial = args();
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useRecordMonitor(input),
      { initialProps: initial },
    );
    const old = fixture.meshes[0]!;
    rerender({ ...initial, snapshot: room("next") });
    act(() => old.onRemoteTrack("peer", stream("retired")));
    expect(fixture.contexts[0]!.createMediaStreamSource).not.toHaveBeenCalled();
    expect(result.current.remoteCount).toBe(0);
    act(() => old.onError?.(new Error("Retained old error")));
    expect(result.current.error).toBe("Retained old error");
    unmount();
  });

  it("ignores a retired mesh's departure so the new connection keeps its peer", async () => {
    const initial = args();
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useRecordMonitor(input),
      { initialProps: initial },
    );
    const old = fixture.meshes[0]!;
    rerender({ ...initial, snapshot: room("next") });
    track("new");
    expect(result.current.remoteCount).toBe(1);
    act(() => old.onRemoteGone("peer"));
    expect(fixture.graphs[0]!.removeRemote).not.toHaveBeenCalled();
    expect(fixture.graphs[1]!.removeRemote).not.toHaveBeenCalled();
    await tick(5);
    expect(result.current.remoteCount).toBe(1);
    unmount();
  });

  it("retains an already-dispatched signal rejection after acquisition cleanup", async () => {
    const held = deferred();
    fixture.signal.mockReturnValueOnce(held.promise);
    const initial = args();
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useRecordMonitor(input),
      { initialProps: initial },
    );
    act(() =>
      emitRecordSignal({
        type: "Signal",
        from: "peer",
        to: "me",
        candidate: { candidate: "synthetic candidate" },
      }),
    );
    expect(fixture.signal).toHaveBeenCalledTimes(1);
    rerender({ ...initial, enabled: false });
    await act(async () => {
      held.reject(new Error("Retained signal error"));
    });
    expect(result.current.error).toBe("Retained signal error");
    unmount();
  });

  it("keeps missing-context failure sticky when a later acquisition succeeds", () => {
    fixture.supported = false;
    const initial = args();
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useRecordMonitor(input),
      { initialProps: initial },
    );
    expect(result.current.error).toBe("AudioContext unavailable");
    expect(result.current.contextGeneration).toBe(0);
    fixture.supported = true;
    rerender({ ...initial, role: "producer" });
    expect(result.current.contextGeneration).toBe(1);
    expect(result.current.error).toBe("AudioContext unavailable");
    unmount();
  });

  it("routes the remembered actual output choice to each new context with a stable command", async () => {
    localStorage.setItem(OUTPUT_KEY, "headset");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "headset", label: "Headset" },
        ],
        addEventListener() {},
        removeEventListener() {},
      },
    });
    const initial = args();
    const { result, rerender, unmount } = renderHook(
      (input: Args) => {
        const monitor = useRecordMonitor(input);
        const output = useOutputDevice(monitor);
        return { monitor, output };
      },
      { initialProps: initial },
    );
    await tick(0);
    expect(result.current.output.selectedId).toBe("headset");
    expect(fixture.contexts[0]!.picks.at(-1)).toBe("headset");
    const command = result.current.monitor.setSinkId;
    rerender({ ...initial, snapshot: room("next") });
    await tick(0);
    expect(result.current.monitor.setSinkId).toBe(command);
    expect(fixture.contexts[1]!.picks.at(-1)).toBe("headset");
    await act(async () => {
      expect(await command("manual")).toBe(true);
    });
    expect(fixture.contexts[1]!.picks.at(-1)).toBe("manual");
    expect(fixture.contexts[0]!.picks).not.toContain("manual");
    unmount();
  });

  it("retires replayed resources before the live StrictMode acquisition", () => {
    const { result, unmount } = renderHook(() => useRecordMonitor(args()), {
      wrapper: StrictMode,
    });
    expect(fixture.contexts).toHaveLength(2);
    expect(fixture.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.contexts[1]!.close).not.toHaveBeenCalled();
    expect(result.current.contextGeneration).toBe(2);
    act(() => fixture.meshes[0]!.onRemoteTrack("peer", stream("retired")));
    expect(result.current.remoteCount).toBe(0);
    unmount();
    expect(fixture.contexts[1]!.close).toHaveBeenCalledTimes(1);
  });
});
