import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubRaf } from "../test/raf";

type Levels = typeof import("./trackPlayLevels");
type Source = typeof import("./playbackMeterSource");
type Store = typeof import("../state/dawStore");
type Latches = typeof import("./playbackClipLatches");

function loud(peak: number): Float32Array {
  const samples = new Float32Array(16);
  samples[0] = peak;
  return samples;
}

describe("trackPlayLevels", () => {
  let raf: ReturnType<typeof stubRaf>;
  let levels: Levels;
  let source: Source;
  let store: Store;
  let latches: Latches;
  let reads: Map<string, Float32Array>;
  let readCount: number;

  beforeEach(async () => {
    vi.resetModules();
    raf = stubRaf();
    levels = await import("./trackPlayLevels");
    source = await import("./playbackMeterSource");
    store = await import("../state/dawStore");
    latches = await import("./playbackClipLatches");
    reads = new Map();
    readCount = 0;
    source.bindPlaybackMeterSource({
      read: (id) => {
        readCount += 1;
        return reads.get(id) ?? null;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const play = () =>
    store.useDawStore.setState({ isPlaying: true, sourcePreview: null });
  const stop = () => store.useDawStore.setState({ isPlaying: false });

  it("publishes a track's level in twelfths while it plays", () => {
    reads.set("t1", loud(0.5));
    levels.watchTrackLevel("t1");
    play();
    raf.fire(1000);
    expect(levels.trackLevel("t1")).toBeCloseTo(Math.round(0.9 * 12) / 12, 5);
  });

  it("keeps one frame loop for two headers on one track and stops it with the last", () => {
    reads.set("t1", loud(0.5));
    play();
    const first = levels.watchTrackLevel("t1");
    const second = levels.watchTrackLevel("t1");
    expect(raf.pendingCount()).toBe(1);
    first();
    raf.fire(1000);
    expect(raf.pendingCount()).toBe(1);
    expect(levels.trackLevel("t1")).toBeGreaterThan(0);
    second();
    expect(raf.cancel).toHaveBeenCalled();
    expect(raf.pendingCount()).toBe(0);
    expect(levels.trackLevel("t1")).toBe(0);
  });

  it("stops the frame loop and clears levels when a playing header unmounts", () => {
    reads.set("t1", loud(0.5));
    play();
    const unwatch = levels.watchTrackLevel("t1");
    raf.fire(1000);
    const heard = vi.fn();
    levels.subscribeTrackLevels(heard);
    unwatch();
    expect(heard).toHaveBeenCalled();
    expect(levels.trackLevel("t1")).toBe(0);
    expect(raf.pendingCount()).toBe(0);
    const before = readCount;
    raf.fire(2000);
    expect(readCount).toBe(before);
  });

  it("does not read or publish for a source preview", () => {
    reads.set("t1", loud(0.5));
    levels.watchTrackLevel("t1");
    store.useDawStore.setState({
      isPlaying: true,
      sourcePreview: { clipId: "c" } as never,
    });
    expect(raf.pendingCount()).toBe(0);
    raf.fire(1000);
    expect(readCount).toBe(0);
    expect(levels.trackLevel("t1")).toBe(0);
  });

  it("clears levels when playback stops", () => {
    reads.set("t1", loud(0.5));
    levels.watchTrackLevel("t1");
    play();
    raf.fire(1000);
    expect(levels.trackLevel("t1")).toBeGreaterThan(0);
    stop();
    expect(levels.trackLevel("t1")).toBe(0);
    expect(raf.pendingCount()).toBe(0);
  });

  it("freezes the ring under reduced motion but still lights the clip latch", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    reads.set("t1", loud(1));
    levels.watchTrackLevel("t1");
    play();
    raf.fire(1000);
    expect(levels.trackLevel("t1")).toBe(0);
    expect(
      latches.playbackTrackClipped(
        "t1",
        store.useDawStore.getState().projectEpoch,
      ),
    ).toBe(true);
  });

  it("publishes at most once per publish interval", () => {
    reads.set("t1", loud(0.5));
    levels.watchTrackLevel("t1");
    play();
    raf.fire(1000);
    const first = levels.trackLevel("t1");
    reads.set("t1", loud(0.05));
    raf.fire(1000 + levels.TRACK_LEVEL_PUBLISH_MS - 1);
    expect(levels.trackLevel("t1")).toBe(first);
    raf.fire(1000 + levels.TRACK_LEVEL_PUBLISH_MS);
    expect(levels.trackLevel("t1")).toBeLessThan(first);
  });
});
