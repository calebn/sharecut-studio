import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordSnapshot } from "../types";
import {
  createPeerLevelTap,
  type PeerLevelTap,
  readPeerLevels,
  sameLevels,
} from "./peerLevels";

type Wire = { from?: Wire; peak?: () => number };

/** A context whose analysers read whatever peak the stream feeding them is given. */
function fakeContext(peaks: Map<string, number>) {
  const analyser = () => {
    const node: Wire & Record<string, unknown> = {
      fftSize: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData(buffer: Float32Array) {
        let upstream: Wire | undefined = node;
        while (upstream && !upstream.peak) upstream = upstream.from;
        buffer.fill(0);
        buffer[0] = upstream?.peak?.() ?? 0;
      },
    };
    return node;
  };
  const splitter = () => {
    const node: Wire & Record<string, unknown> = {
      disconnect: vi.fn(),
      connect: (target: Wire) => {
        target.from = node;
      },
    };
    return node;
  };
  return {
    destination: {},
    createGain: () => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createAnalyser: analyser,
    createChannelSplitter: splitter,
    createMediaStreamSource: (stream: { id: string }) => {
      const node: Wire & Record<string, unknown> = {
        peak: () => peaks.get(stream.id) ?? 0,
        connect: (target: Wire) => {
          target.from = node;
        },
        disconnect: vi.fn(),
      };
      return node;
    },
    resume: async () => undefined,
    close: async () => undefined,
  };
}

describe("createPeerLevelTap", () => {
  it("reads a peer's peak as a 0 to 1 level and nothing for silence", () => {
    const peaks = new Map([["a", 0.5]]);
    const ctx = fakeContext(peaks);
    const tap = createPeerLevelTap(
      ctx as never,
      ctx.createMediaStreamSource({ id: "a" }) as never,
    ) as PeerLevelTap;
    expect(tap.read()).toBeCloseTo(0.9, 1);
    peaks.set("a", 0);
    expect(tap.read()).toBe(0);
    tap.dispose();
  });

  it("disposes every node even when the source was already disconnected", () => {
    const ctx = fakeContext(new Map());
    const source = ctx.createMediaStreamSource({ id: "a" });
    source.disconnect = vi.fn((target?: unknown) => {
      if (target) throw new DOMException("not connected", "InvalidAccessError");
    });
    const splitters: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    const makeSplitter = ctx.createChannelSplitter;
    ctx.createChannelSplitter = (() => {
      const node = makeSplitter();
      splitters.push(node as never);
      return node;
    }) as never;
    const tap = createPeerLevelTap(
      ctx as never,
      source as never,
    ) as PeerLevelTap;
    expect(() => tap.dispose()).not.toThrow();
    expect(splitters[0].disconnect).toHaveBeenCalled();
  });

  it("returns null when the context cannot build an analyser", () => {
    const ctx = fakeContext(new Map());
    ctx.createAnalyser = () => {
      throw new Error("no analyser");
    };
    expect(
      createPeerLevelTap(
        ctx as never,
        ctx.createMediaStreamSource({ id: "a" }) as never,
      ),
    ).toBeNull();
  });
});

describe("readPeerLevels and sameLevels", () => {
  it("keeps one level per peer in 5% steps", () => {
    const taps = new Map<string, PeerLevelTap>([
      ["a", { read: () => 0.52, dispose: vi.fn() }],
      ["b", { read: () => 0, dispose: vi.fn() }],
    ]);
    const levels = readPeerLevels(taps);
    expect(Object.keys(levels)).toEqual(["a", "b"]);
    expect(levels.a).toBeCloseTo(0.5);
    expect(levels.b).toBe(0);
  });

  it("compares by peers and values", () => {
    expect(sameLevels({ a: 0.5 }, { a: 0.5 })).toBe(true);
    expect(sameLevels({ a: 0.5 }, { a: 0.55 })).toBe(false);
    expect(sameLevels({ a: 0.5 }, { b: 0.5 })).toBe(false);
    expect(sameLevels({}, { a: 0 })).toBe(false);
  });
});

const meshes: {
  onRemoteTrack: (peerId: string, stream: { id: string }) => void;
  onRemoteGone: (peerId: string) => void;
}[] = [];
const peaks = new Map<string, number>();
const sinkCalls: string[] = [];
class FakeContext {
  constructor() {
    return Object.assign(
      fakeContext(peaks),
      "setSinkId" in FakeContext.prototype
        ? {
            setSinkId: (id: string) => {
              sinkCalls.push(id);
              return Promise.resolve();
            },
          }
        : {},
    );
  }
}

vi.mock("./mesh", () => ({
  RecordMesh: class {
    constructor(opts: (typeof meshes)[number]) {
      meshes.push(opts);
    }
    dispose() {}
    setLocalStream() {}
    setSendEnabled() {}
    syncPeers() {}
    async handleSignal() {}
  },
}));
vi.mock("../../audio/mixMinus", () => ({
  MIX_MINUS_RAMP_S: 0,
  MixMinusGraph: class {
    addRemote() {}
    removeRemote() {}
    setRemoteMuted() {}
    disconnectLocal() {}
    dispose() {}
  },
}));
vi.mock("../../utils/audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/audio")>()),
  audioContextCtor: () => FakeContext,
}));

describe("useRecordMonitor levels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    meshes.length = 0;
    peaks.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("returns a level per remote peer and drops it when they go", async () => {
    const { useRecordMonitor } = await import("./useRecordMonitor");
    const { result } = renderHook(() =>
      useRecordMonitor({
        enabled: true,
        localId: "p_me",
        role: "guest",
        snapshot: {
          session_id: "s1",
          participants: [],
        } as unknown as RecordSnapshot,
        localStream: null,
        muted: false,
        send: vi.fn(),
      }),
    );
    expect(result.current.levels).toEqual({});
    const mesh = meshes[0];
    peaks.set("host", 0.5);
    peaks.set("anneke", 0.05);
    act(() => {
      mesh.onRemoteTrack("p_host", { id: "host" });
      mesh.onRemoteTrack("p_anneke", { id: "anneke" });
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(Object.keys(result.current.levels).sort()).toEqual([
      "p_anneke",
      "p_host",
    ]);
    expect(result.current.levels.p_host).toBeGreaterThan(
      result.current.levels.p_anneke,
    );
    peaks.set("host", 0);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.levels.p_host).toBe(0);
    act(() => {
      mesh.onRemoteGone("p_host");
      vi.advanceTimersByTime(300);
    });
    expect(Object.keys(result.current.levels)).toEqual(["p_anneke"]);
  });

  it("clears the levels when the monitor is switched off", async () => {
    const { useRecordMonitor } = await import("./useRecordMonitor");
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useRecordMonitor({
          enabled,
          localId: "p_me",
          role: "guest",
          snapshot: {
            session_id: "s1",
            participants: [],
          } as unknown as RecordSnapshot,
          localStream: null,
          muted: false,
          send: vi.fn(),
        }),
      { initialProps: { enabled: true } },
    );
    peaks.set("host", 0.5);
    act(() => meshes[0].onRemoteTrack("p_host", { id: "host" }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(Object.keys(result.current.levels)).toEqual(["p_host"]);
    rerender({ enabled: false });
    expect(result.current.levels).toEqual({});
  });
});

describe("useRecordMonitor speaker", () => {
  const args = {
    localId: "p_me",
    role: "guest" as const,
    snapshot: {
      session_id: "s1",
      participants: [],
    } as unknown as RecordSnapshot,
    localStream: null,
    muted: false,
    send: vi.fn(),
  };

  beforeEach(() => {
    meshes.length = 0;
    peaks.clear();
    sinkCalls.length = 0;
  });
  afterEach(() => {
    Reflect.deleteProperty(FakeContext.prototype, "setSinkId");
  });

  it("is selectable only when the AudioContext prototype has setSinkId", async () => {
    const { outputSelectable } = await import("./useRecordMonitor");
    expect(outputSelectable()).toBe(false);
    Object.defineProperty(FakeContext.prototype, "setSinkId", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    expect(outputSelectable()).toBe(true);
  });

  it("counts each context and routes setSinkId to the live one", async () => {
    Object.defineProperty(FakeContext.prototype, "setSinkId", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    const { useRecordMonitor } = await import("./useRecordMonitor");
    const { result, rerender } = renderHook(
      ({ enabled }) => useRecordMonitor({ ...args, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.outputSupported).toBe(true);
    expect(result.current.contextGeneration).toBe(0);
    await expect(result.current.setSinkId("hp")).resolves.toBe(false);
    expect(sinkCalls).toEqual([]);
    rerender({ enabled: true });
    expect(result.current.contextGeneration).toBe(1);
    await expect(result.current.setSinkId("hp")).resolves.toBe(true);
    expect(sinkCalls).toEqual(["hp"]);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.contextGeneration).toBe(2);
  });

  it("is a no-op when the context cannot pick a speaker", async () => {
    const { useRecordMonitor } = await import("./useRecordMonitor");
    const { result } = renderHook(() =>
      useRecordMonitor({ ...args, enabled: true }),
    );
    expect(result.current.outputSupported).toBe(false);
    await expect(result.current.setSinkId("hp")).resolves.toBe(false);
    expect(sinkCalls).toEqual([]);
  });
});
