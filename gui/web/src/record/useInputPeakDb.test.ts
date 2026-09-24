import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";
import { useInputPeakDb } from "./useInputPeakDb";

const micA = {} as MediaStream;
const micB = {} as MediaStream;

type Message = {
  type?: "clearAck";
  peak?: number;
  clipped?: boolean;
  epoch: number;
  hotBlocks: number;
};

function stubAudioGraph(
  options: {
    state?: AudioContextState;
    modulePromise?: Promise<void>;
    throwOnSource?: boolean;
    global?: "AudioContext" | "webkitAudioContext";
  } = {},
) {
  const listeners = new Set<() => void>();
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const silent = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const nodes: Array<{
    port: {
      onmessage: ((event: MessageEvent<Message>) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    emit: (message: Message) => void;
  }> = [];
  const Node = vi.fn(function () {
    const node = {
      port: {
        onmessage: null as ((event: MessageEvent<Message>) => void) | null,
        postMessage: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
      emit(message: Message) {
        node.port.onmessage?.({ data: message } as MessageEvent<Message>);
      },
    };
    nodes.push(node);
    return node;
  });
  const ctx = {
    state: options.state ?? "running",
    destination: {},
    audioWorklet: {
      addModule: vi.fn(() => options.modulePromise ?? Promise.resolve()),
    },
    createMediaStreamSource: vi.fn(() => {
      if (options.throwOnSource) throw new Error("no audio track");
      return source;
    }),
    createGain: vi.fn(() => silent),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn((_: string, listener: () => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_: string, listener: () => void) =>
      listeners.delete(listener),
    ),
    setState(next: AudioContextState) {
      ctx.state = next;
      for (const listener of listeners) listener();
    },
  };
  const Ctor = vi.fn(function () {
    return ctx;
  });
  vi.stubGlobal(
    "AudioContext",
    options.global === "webkitAudioContext" ? undefined : Ctor,
  );
  vi.stubGlobal(
    "webkitAudioContext",
    options.global === "webkitAudioContext" ? Ctor : undefined,
  );
  vi.stubGlobal("AudioWorkletNode", Node);
  return { ctx, source, silent, nodes, Node, Ctor };
}

async function ready(nodes: ReturnType<typeof stubAudioGraph>["nodes"]) {
  await waitFor(() => expect(nodes).toHaveLength(1));
  return nodes[0];
}

describe("useInputPeakDb", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a silent worklet graph and reads peak blocks on rAF", async () => {
    const raf = stubRaf();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA));
    const node = await ready(graph.nodes);
    expect(graph.ctx.audioWorklet.addModule).toHaveBeenCalledWith(
      expect.stringContaining("inputMeterProcessor"),
    );
    expect(graph.Node).toHaveBeenCalledWith(graph.ctx, "sharecut-input-meter", {
      processorOptions: { clipThreshold: 10 ** (-1 / 20) },
    });
    expect(graph.source.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(graph.silent);
    expect(graph.silent.gain.value).toBe(0);
    expect(graph.silent.connect).toHaveBeenCalledWith(graph.ctx.destination);
    act(() => {
      node.emit({ peak: 0.3, clipped: false, epoch: 0, hotBlocks: 0 });
      node.emit({ peak: 0.5, clipped: false, epoch: 0, hotBlocks: 0 });
      raf.fire(1000);
    });
    expect(result.current.levelDb).toBeCloseTo(-6.02, 2);
    expect(result.current.peakHoldDb).toBeCloseTo(-6.02, 2);
    clock.mockReturnValue(1150);
    act(() => raf.fire(1150));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("keeps steady input visible between 8-block worklet reports", async () => {
    const raf = stubRaf();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA));
    const node = await ready(graph.nodes);
    act(() => node.emit({ peak: 0.5, clipped: false, epoch: 0, hotBlocks: 0 }));
    act(() => raf.fire(1000));
    clock.mockReturnValue(1017);
    act(() => raf.fire(1017));
    expect(result.current.levelDb).toBeCloseTo(-6.02, 2);
    clock.mockReturnValue(1021);
    act(() => node.emit({ peak: 0.5, clipped: false, epoch: 0, hotBlocks: 0 }));
    clock.mockReturnValue(1034);
    act(() => raf.fire(1034));
    expect(result.current.levelDb).toBeCloseTo(-6.02, 2);
    clock.mockReturnValue(1130);
    act(() => raf.fire(1130));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("keeps the loudest report until sampled, then holds the latest report", async () => {
    const raf = stubRaf();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA));
    const node = await ready(graph.nodes);
    act(() => {
      node.emit({ peak: 0.8, clipped: false, epoch: 0, hotBlocks: 0 });
      node.emit({ peak: 0.1, clipped: false, epoch: 0, hotBlocks: 0 });
      raf.fire(1000);
    });
    expect(result.current.levelDb).toBeCloseTo(-1.94, 2);
    clock.mockReturnValue(1050);
    act(() => raf.fire(1050));
    expect(result.current.levelDb).toBeCloseTo(-20, 2);
  });

  it("latches a hidden-tab clip without an animation frame and survives quiet blocks", async () => {
    stubRaf();
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA));
    const node = await ready(graph.nodes);
    act(() => node.emit({ peak: 0.95, clipped: true, epoch: 0, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(true);
    act(() => node.emit({ peak: 0, clipped: true, epoch: 0, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(true);
  });

  it("clearClip ignores queued old messages and re-latches in a new epoch", async () => {
    stubRaf();
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA, { clipDb: -6 }));
    const node = await ready(graph.nodes);
    expect(graph.Node).toHaveBeenCalledWith(graph.ctx, "sharecut-input-meter", {
      processorOptions: { clipThreshold: 10 ** (-6 / 20) },
    });
    act(() => node.emit({ peak: 0.7, clipped: true, epoch: 0, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(true);
    act(() => result.current.clearClip());
    expect(node.port.postMessage).toHaveBeenCalledWith({
      type: "clear",
      epoch: 1,
    });
    expect(result.current.clipped).toBe(false);
    act(() => node.emit({ peak: 0.95, clipped: true, epoch: 0, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(false);
    act(() => node.emit({ type: "clearAck", epoch: 1, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(false);
    act(() => node.emit({ peak: 0.7, clipped: true, epoch: 1, hotBlocks: 2 }));
    expect(result.current.clipped).toBe(true);
  });

  it("re-latches when a hot block ran after clear but before the worklet handled it", async () => {
    stubRaf();
    const graph = stubAudioGraph();
    const { result } = renderHook(() => useInputPeakDb(micA));
    const node = await ready(graph.nodes);
    act(() => result.current.clearClip());
    act(() => node.emit({ peak: 0.95, clipped: true, epoch: 0, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(false);
    act(() => node.emit({ type: "clearAck", epoch: 1, hotBlocks: 1 }));
    expect(result.current.clipped).toBe(true);
  });

  it("resets on stream switch and disconnects the previous graph", async () => {
    stubRaf();
    const graph = stubAudioGraph();
    const { result, rerender } = renderHook(
      ({ stream }: { stream: MediaStream | null }) => useInputPeakDb(stream),
      { initialProps: { stream: micA as MediaStream | null } },
    );
    const old = await ready(graph.nodes);
    act(() => old.emit({ peak: 0.95, clipped: true, epoch: 0, hotBlocks: 1 }));
    rerender({ stream: micB });
    expect(result.current.clipped).toBe(false);
    expect(graph.ctx.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(graph.nodes).toHaveLength(2));
    expect(old.port.onmessage).toBeNull();
    expect(old.disconnect).toHaveBeenCalled();
    expect(graph.source.disconnect).toHaveBeenCalled();
    rerender({ stream: null });
    expect(result.current.clipped).toBe(false);
    expect(graph.ctx.close).toHaveBeenCalledTimes(2);
  });

  it("closes a context if unmounted before addModule resolves", async () => {
    stubRaf();
    let resolveModule!: () => void;
    const modulePromise = new Promise<void>((resolve) => {
      resolveModule = resolve;
    });
    const graph = stubAudioGraph({ modulePromise });
    const { unmount } = renderHook(() => useInputPeakDb(micA));
    unmount();
    await act(async () => resolveModule());
    expect(graph.nodes).toHaveLength(0);
    expect(graph.ctx.close).toHaveBeenCalledTimes(1);
  });

  it("does not attach the old stream after a switch during module load", async () => {
    stubRaf();
    let resolveModule!: () => void;
    const modulePromise = new Promise<void>((resolve) => {
      resolveModule = resolve;
    });
    const graph = stubAudioGraph({ modulePromise });
    const { rerender } = renderHook(
      ({ stream }: { stream: MediaStream }) => useInputPeakDb(stream),
      { initialProps: { stream: micA } },
    );
    rerender({ stream: micB });
    await act(async () => resolveModule());
    expect(graph.ctx.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(graph.ctx.createMediaStreamSource).toHaveBeenCalledWith(micB);
    expect(graph.nodes).toHaveLength(1);
  });

  it("handles construction failure and rejected close without leaking", async () => {
    stubRaf();
    const graph = stubAudioGraph({ throwOnSource: true });
    graph.ctx.close.mockImplementation(() =>
      Promise.reject(new Error("closed")),
    );
    const { result, unmount } = renderHook(() => useInputPeakDb(micA));
    await waitFor(() => expect(graph.ctx.close).toHaveBeenCalledTimes(1));
    expect(result.current.levelDb).toBe(Number.NEGATIVE_INFINITY);
    unmount();
    expect(graph.ctx.close).toHaveBeenCalledTimes(1);
  });

  it("reports suspended state and resumes from a user gesture", async () => {
    stubRaf();
    const graph = stubAudioGraph({ state: "suspended" });
    const { result } = renderHook(() => useInputPeakDb(micA));
    await ready(graph.nodes);
    expect(result.current.suspended).toBe(true);
    act(() => graph.ctx.setState("running"));
    expect(result.current.suspended).toBe(false);
    act(() => graph.ctx.setState("interrupted" as AudioContextState));
    expect(result.current.suspended).toBe(true);
    act(() => result.current.resume());
    expect(graph.ctx.resume).toHaveBeenCalledTimes(2);
  });

  it("stays inert without a stream or AudioContext and supports webkitAudioContext", async () => {
    stubRaf();
    const graph = stubAudioGraph({ global: "webkitAudioContext" });
    const noStream = renderHook(() => useInputPeakDb(null));
    expect(graph.Ctor).not.toHaveBeenCalled();
    noStream.unmount();
    const withStream = renderHook(() => useInputPeakDb(micA));
    await ready(graph.nodes);
    expect(graph.Ctor).toHaveBeenCalled();
    withStream.unmount();
    vi.stubGlobal("webkitAudioContext", undefined);
    const missing = renderHook(() => useInputPeakDb(micA));
    expect(missing.result.current.suspended).toBe(false);
    act(() => missing.result.current.resume());
  });
});
