import { describe, expect, it, vi } from "vitest";
import { createMutedSpeechTap } from "./mutedSpeechTap";

function fakeGraph(
  amplitude: number,
  options: { throwOnClone?: boolean; state?: AudioContextState } = {},
) {
  const cloneTrack = { enabled: false, stop: vi.fn() };
  const original = { enabled: false, stop: vi.fn() };
  const clone = vi.fn(() => {
    if (options.throwOnClone) throw new Error("no clone");
    return {
      getAudioTracks: () => [cloneTrack],
      getTracks: () => [cloneTrack],
    };
  });
  const stream = {
    clone,
    getAudioTracks: () => [original],
    getTracks: () => [original],
  } as unknown as MediaStream;
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buffer: Float32Array) =>
      buffer.fill(amplitude),
    ),
  };
  const silent = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const destination = {} as AudioDestinationNode;
  const ctx = {
    state: options.state ?? "running",
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    createGain: vi.fn(() => silent),
    destination,
  } as unknown as AudioContext;
  return {
    ctx,
    stream,
    clone,
    cloneTrack,
    original,
    source,
    analyser,
    silent,
    destination,
  };
}

describe("createMutedSpeechTap", () => {
  it("reads block RMS in dBFS", () => {
    const graph = fakeGraph(0.1);
    const tap = createMutedSpeechTap(graph.ctx, graph.stream);
    expect(tap?.readDb()).toBeCloseTo(-20, 5);
    expect(graph.analyser.fftSize).toBe(1024);
  });

  it("reads nothing unless the context is running", () => {
    for (const state of ["suspended", "closed"] as const) {
      const graph = fakeGraph(0.5, { state });
      const tap = createMutedSpeechTap(graph.ctx, graph.stream);
      expect(tap?.readDb()).toBeNull();
      expect(graph.analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
    }
  });

  it("floors digital silence", () => {
    const graph = fakeGraph(0);
    expect(createMutedSpeechTap(graph.ctx, graph.stream)?.readDb()).toBe(-120);
  });

  it("enables its own clone and leaves the original track alone", () => {
    const graph = fakeGraph(0.1);
    createMutedSpeechTap(graph.ctx, graph.stream);
    expect(graph.cloneTrack.enabled).toBe(true);
    expect(graph.original.enabled).toBe(false);
    expect(graph.original.stop).not.toHaveBeenCalled();
  });

  it("feeds only a local analyser through a zero-gain sink", () => {
    const graph = fakeGraph(0.1);
    createMutedSpeechTap(graph.ctx, graph.stream);
    expect(graph.source.connect).toHaveBeenCalledWith(graph.analyser);
    expect(graph.analyser.connect).toHaveBeenCalledWith(graph.silent);
    expect(graph.silent.connect).toHaveBeenCalledWith(graph.destination);
    expect(graph.silent.gain.value).toBe(0);
    expect(graph.source.connect).toHaveBeenCalledTimes(1);
  });

  it("stops the clone and goes silent once disposed", () => {
    const graph = fakeGraph(0.1);
    const tap = createMutedSpeechTap(graph.ctx, graph.stream);
    tap?.dispose();
    tap?.dispose();
    expect(graph.cloneTrack.stop).toHaveBeenCalledOnce();
    expect(graph.source.disconnect).toHaveBeenCalledOnce();
    expect(graph.original.stop).not.toHaveBeenCalled();
    expect(tap?.readDb()).toBeNull();
  });

  it("returns null and stops the clone when the graph cannot be built", () => {
    const graph = fakeGraph(0.1);
    vi.mocked(graph.ctx.createMediaStreamSource).mockImplementation(() => {
      throw new Error("no source");
    });
    expect(createMutedSpeechTap(graph.ctx, graph.stream)).toBeNull();
    expect(graph.cloneTrack.stop).toHaveBeenCalledOnce();
  });

  it("returns null when the stream cannot be cloned", () => {
    const graph = fakeGraph(0.1, { throwOnClone: true });
    expect(createMutedSpeechTap(graph.ctx, graph.stream)).toBeNull();
  });
});
