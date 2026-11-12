import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipRow } from "../types/project";
import { leavePlaybackSession } from "./playbackSession";
import { ProxyEngine } from "./proxyEngine";
import type { ImmutableChunkRef, ProxyManifest } from "./proxyMath";

interface FakeSentinel {
  offset: { value: number };
  onended: (() => void) | null;
  stopAt: number | null;
  fired: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

vi.mock("./playbackSession", () => ({
  enterPlaybackSession: vi.fn(),
  leavePlaybackSession: vi.fn(),
}));

function makeCtx() {
  const sentinels: FakeSentinel[] = [];
  const created: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    playbackRate: { value: number };
    buffer: AudioBuffer | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const gains: Array<{
    connect: ReturnType<typeof vi.fn>;
    gain: {
      value: number;
      setTargetAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const ctx = {
    createChannelSplitter: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createAnalyser: vi.fn(() => ({
      fftSize: 2048,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((samples: Float32Array) =>
        samples.fill(0.5),
      ),
    })),
    state: "running",
    currentTime: 0,
    destination: {},
    createGain: () => {
      const gain = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          setTargetAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    },
    createConstantSource: () => {
      const node: FakeSentinel = {
        offset: { value: 1 },
        onended: null,
        stopAt: null,
        fired: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn((when?: number) => {
          node.stopAt = when ?? null;
        }),
      };
      sentinels.push(node);
      return node;
    },
    createBufferSource: () => {
      const source = {
        buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      created.push(source);
      return source;
    },
    decodeAudioData: vi.fn(
      async (ab: ArrayBuffer) =>
        ({
          length: ab.byteLength || 48000,
          duration: 1,
          numberOfChannels: 1,
          sampleRate: 48000,
        }) as AudioBuffer,
    ),
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    ctx: ctx as unknown as AudioContext,
    created,
    sentinels,
    gains,
    decode: ctx.decodeAudioData,
    analysers: ctx.createAnalyser,
    splitter: ctx.createChannelSplitter,
    close: ctx.close,
    suspend: ctx.suspend,
    setState: (state: string) => {
      ctx.state = state;
    },
    setTime: (time: number) => {
      ctx.currentTime = time;
    },
  };
}

describe("ProxyEngine", () => {
  it("lazily taps output gains with separated channels and releases removed tracks", async () => {
    const { ctx, gains, analysers, splitter, close, suspend, setState } =
      makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      artifacts: {},
      occurrences: {},
      tracks: {
        host: {
          hash: "x",
          chunk_sec: 60,
          overlap_ms: 0,
          chunk_count: 0,
          duration_sec: 10,
          urls: [],
        },
      },
    };
    engine.setSnapshot({
      manifest,
      clipsByTrack: {},
      tracks: [{ id: "host", gain_db: 6, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    expect(engine.readTrackFrame("host")).toBeNull();
    expect(analysers).not.toHaveBeenCalled();
    engine.play(0);
    expect(engine.readTrackFrame("host")).toBeNull();
    await Promise.resolve();
    analysers.mockImplementationOnce(() => {
      throw new Error("temporary analysis failure");
    });
    expect(engine.readTrackFrame("host")).toBeNull();
    expect(splitter.mock.results[0]?.value.disconnect).toHaveBeenCalledOnce();
    const samples = engine.readTrackFrame("host");
    expect(samples?.length).toBe(4096);
    expect(samples?.[0]).toBe(0.5);
    expect(samples?.[2048]).toBe(0.5);
    expect(analysers).toHaveBeenCalledTimes(3);
    setState("suspended");
    expect(engine.readTrackFrame("host")).toBeNull();
    setState("interrupted");
    expect(engine.readTrackFrame("host")).toBeNull();
    setState("running");
    expect(engine.readTrackFrame("host")?.[0]).toBe(0.5);
    const analyser = analysers.mock.results.find(
      (result) => result.type === "return",
    )?.value;
    analyser?.getFloatTimeDomainData.mockImplementationOnce(() => {
      throw new Error("temporary read failure");
    });
    expect(engine.readTrackFrame("host")).toBeNull();
    expect(engine.readTrackFrame("host")?.[0]).toBe(0.5);
    expect(gains[1]?.gain.value).toBeCloseTo(1.995262);
    const split = splitter.mock.results.at(-1)?.value;
    engine.setSnapshot({
      manifest,
      clipsByTrack: {},
      tracks: [],
      durationSec: Number.POSITIVE_INFINITY,
    });
    expect(split?.disconnect).toHaveBeenCalledOnce();
    expect(engine.readTrackFrame("host")).toBeNull();
    engine.pause();
    expect(suspend).toHaveBeenCalled();
    engine.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("schedules sources for clips in the window", async () => {
    const { ctx, created } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      artifacts: {},
      occurrences: {},
      tracks: {
        host: {
          hash: "abc",
          chunk_sec: 60,
          overlap_ms: 200,
          chunk_count: 1,
          duration_sec: 10,
          urls: ["/c0.mp3"],
        },
      },
    };
    const clips: ClipRow[] = [
      {
        id: "c1",
        track_id: "host",
        source_start: 0,
        source_end: 5,
        timeline_start: 0,
        timeline_end: 5,
        fade_in_ms: 0,
        fade_out_ms: 0,
        join_in_mode: "fade",
        source_id: null,
        source_duration_sec: null,
        recording_key: null,
      },
    ];
    engine.setSnapshot({
      manifest,
      clipsByTrack: { host: clips },
      tracks: [{ id: "host", gain_db: 0, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.play(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(created.length).toBeGreaterThan(0);
    expect(created[0].start).toHaveBeenCalled();
    engine.dispose();
  });

  it("plays each track at its output gain; the saved mute beats solo", () => {
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      tracks: {},
      artifacts: {},
      occurrences: {},
    };
    const { ctx, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot({
      manifest,
      clipsByTrack: {},
      tracks: [
        { id: "host", gain_db: -2, fader_db: -4, muted: false },
        { id: "guest", gain_db: 0, muted: true },
        { id: "cohost", gain_db: 0, muted: false },
      ],
      durationSec: Number.POSITIVE_INFINITY,
    });
    // gains[0] is the master; then one per track, in order.
    const level = () => gains.slice(1).map((g) => g.gain.value);
    expect(level()[0]).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(level().slice(1)).toEqual([0, 1]);

    engine.setSolo({ guest: true });
    expect(level()).toEqual([0, 0, 0]);
    engine.setSolo({ cohost: true });
    expect(level()).toEqual([0, 0, 1]);
    engine.setListenMute({ cohost: true });
    expect(level()).toEqual([0, 0, 0]);
    engine.dispose();
  });

  it("glides a live volume change without rescheduling the audio", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      artifacts: {},
      occurrences: {},
      tracks: {
        host: {
          hash: "abc",
          chunk_sec: 60,
          overlap_ms: 200,
          chunk_count: 1,
          duration_sec: 10,
          urls: ["/c0.mp3"],
        },
      },
    };
    const clips = {
      host: [
        {
          id: "c1",
          track_id: "host",
          source_start: 0,
          source_end: 5,
          timeline_start: 0,
          timeline_end: 5,
          fade_in_ms: 0,
          fade_out_ms: 0,
          join_in_mode: "fade" as const,
          source_id: null,
          source_duration_sec: null,
          recording_key: null,
        },
      ],
    };
    engine.setSnapshot({
      manifest,
      clipsByTrack: clips,
      tracks: [{ id: "host", gain_db: 0, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.play(0);
    await new Promise((r) => setTimeout(r, 20));
    const scheduled = created.length;
    expect(scheduled).toBeGreaterThan(0);

    // A full snapshot's fresh but equal clips don't reschedule either.
    engine.setSnapshot({
      manifest,
      clipsByTrack: structuredClone(clips),
      tracks: [{ id: "host", gain_db: 0, fader_db: -6, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toHaveLength(scheduled);
    expect(gains[1].gain.setTargetAtTime).toHaveBeenCalledWith(
      expect.closeTo(10 ** (-6 / 20), 6),
      0,
      expect.any(Number),
    );
    engine.dispose();
  });
  it("anchors rate changes and scales start, catch-up and fades", async () => {
    const { ctx, created, gains, setTime } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      artifacts: {},
      occurrences: {},
      tracks: {
        host: {
          hash: "rate",
          chunk_sec: 60,
          overlap_ms: 0,
          chunk_count: 1,
          duration_sec: 20,
          urls: ["u"],
        },
      },
    };
    engine.setSnapshot({
      manifest,
      clipsByTrack: {
        host: [
          {
            id: "c",
            track_id: "host",
            source_start: 0,
            source_end: 10,
            timeline_start: 2,
            timeline_end: 12,
            fade_in_ms: 1000,
            fade_out_ms: 2000,
            join_in_mode: "fade",
            source_id: null,
            source_duration_sec: null,
            recording_key: null,
          },
        ],
      },
      tracks: [{ id: "host", gain_db: 0, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.setPlaybackRate(2);
    engine.play(0);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].playbackRate.value).toBe(2);
    expect(created[0].start).toHaveBeenCalledWith(1, 0, 10);
    expect(gains.at(-1)?.gain).toBeDefined();
    const clipGain = gains.at(-1)?.gain;
    if (!clipGain) throw new Error("missing clip gain");
    expect(clipGain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 1.5);
    expect(clipGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 6);
    setTime(2);
    expect(engine.currentTimeSec()).toBe(4);
    engine.setPlaybackRate(1.5);
    expect(engine.currentTimeSec()).toBe(4);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[1].playbackRate.value).toBe(1.5);
    expect(created[1].start).toHaveBeenCalledWith(2, 2, 8);
    expect(gains.at(-1)?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      expect.closeTo(7.333333333333333, 10),
    );
    setTime(4);
    expect(engine.currentTimeSec()).toBe(7);
    engine.pause();
    setTime(8);
    expect(engine.currentTimeSec()).toBe(7);
  });

  it("an older async schedule cannot stop or replace a newer seek", async () => {
    const { ctx, created } = makeCtx();
    const releases: Array<(buffer: ArrayBuffer) => void> = [];
    const engine = new ProxyEngine(
      ctx,
      () => new Promise((resolve) => releases.push(resolve)),
      vi.fn(),
      vi.fn(),
    );
    const manifest: ProxyManifest = {
      revision: "r",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      artifacts: {},
      occurrences: {},
      tracks: {
        host: {
          hash: "race",
          chunk_sec: 60,
          overlap_ms: 0,
          chunk_count: 1,
          duration_sec: 20,
          urls: ["u"],
        },
      },
    };
    engine.setSnapshot({
      manifest,
      clipsByTrack: {
        host: [
          {
            id: "c",
            track_id: "host",
            source_start: 0,
            source_end: 20,
            timeline_start: 0,
            timeline_end: 20,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
            source_duration_sec: null,
            recording_key: null,
          },
        ],
      },
      tracks: [{ id: "host", gain_db: 0, muted: false }],
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.play(0);
    engine.seek(5);
    releases[1](new ArrayBuffer(64));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].start).toHaveBeenCalledWith(0, 5, 15);
    releases[0](new ArrayBuffer(64));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created).toHaveLength(1);
    expect(created[0].stop).not.toHaveBeenCalled();
    engine.dispose();
    expect(created[0].stop).toHaveBeenCalledOnce();
  });
});

function snapshot(hash = "a".repeat(16), url = "legacy", chunkSec = 60) {
  return {
    manifest: {
      revision: hash,
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      tracks: {
        host: {
          hash,
          chunk_sec: chunkSec,
          overlap_ms: 0,
          chunk_count: 2,
          duration_sec: chunkSec * 2,
          urls: [url, `${url}1`],
        },
      },
      artifacts: {},
      occurrences: {},
    } as ProxyManifest,
    clipsByTrack: {
      host: [
        {
          id: "c",
          track_id: "host",
          source_start: 0,
          source_end: 20,
          timeline_start: 0,
          timeline_end: 20,
          fade_in_ms: 0,
          fade_out_ms: 0,
          join_in_mode: "fade" as const,
          source_id: null,
          source_duration_sec: null,
          recording_key: null,
        },
      ],
    },
    tracks: [{ id: "host", gain_db: 0, muted: false }],
    durationSec: Number.POSITIVE_INFINITY,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("immutable playback snapshots", () => {
  it("replaces a playing artifact at the current position and reuses unchanged bytes", async () => {
    const { ctx, created, setTime } = makeCtx();
    const fetch = vi.fn(async (_ref: ImmutableChunkRef) => new ArrayBuffer(64));
    const engine = new ProxyEngine(ctx, fetch, vi.fn(), vi.fn());
    engine.setSnapshot(snapshot());
    engine.play(1);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    setTime(3);
    engine.setSnapshot(snapshot("b".repeat(64), "replacement"));
    expect(created[0].stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[1].start).toHaveBeenCalledWith(3, 4, 16);
    expect(fetch.mock.calls.map(([ref]) => ref.url)).toEqual([
      "legacy",
      "replacement",
    ]);
    engine.setSnapshot({
      ...snapshot("b".repeat(64), "replacement"),
      manifest: {
        ...snapshot("b".repeat(64), "replacement").manifest,
        revision: "another-basis",
      },
      durationSec: Number.POSITIVE_INFINITY,
    });
    expect(created).toHaveLength(2);
    engine.seek(5);
    await vi.waitFor(() => expect(created).toHaveLength(3));
    expect(fetch).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("does not decode a fetch that finishes after replacement", async () => {
    const { ctx, decode, created } = makeCtx();
    const old = deferred<ArrayBuffer>();
    const fetch = vi.fn((ref: { url: string }) =>
      ref.url === "legacy"
        ? old.promise
        : Promise.resolve(new ArrayBuffer(128)),
    );
    const failure = vi.fn();
    const engine = new ProxyEngine(ctx, fetch, failure, vi.fn());
    engine.setSnapshot(snapshot());
    engine.play(0);
    engine.setSnapshot(snapshot("b".repeat(64), "replacement"));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    old.resolve(new ArrayBuffer(64));
    await old.promise;
    await Promise.resolve();
    expect(decode).toHaveBeenCalledOnce();
    expect(created[0].buffer?.length).toBe(128);
    expect(created[0].stop).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("does not cache or schedule an obsolete decode even when the immutable key recurs", async () => {
    const { ctx, decode, created } = makeCtx();
    const stale = deferred<AudioBuffer>();
    decode.mockImplementationOnce(() => stale.promise);
    const fetch = vi.fn(async (_ref: ImmutableChunkRef) => new ArrayBuffer(64));
    const engine = new ProxyEngine(ctx, fetch, vi.fn(), vi.fn());
    engine.setSnapshot(snapshot());
    engine.play(0);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    engine.setSnapshot(snapshot("b".repeat(64), "replacement"));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    stale.resolve({ length: 999 } as AudioBuffer);
    await stale.promise;
    await Promise.resolve();
    engine.setSnapshot(snapshot());
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(created[1].buffer?.length).toBe(64);
    engine.dispose();
  });

  it("invalidates pending work on pause and ignores obsolete failures", async () => {
    const { ctx, decode, created } = makeCtx();
    const pending = deferred<ArrayBuffer>();
    const failure = vi.fn();
    const engine = new ProxyEngine(
      ctx,
      () => pending.promise,
      failure,
      vi.fn(),
    );
    engine.setSnapshot(snapshot());
    engine.play(0);
    engine.pause();
    pending.reject(new Error("late failure"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(decode).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(failure).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("reports a current decode failure with its immutable reference and stops playback", async () => {
    const { ctx, decode, created, setTime } = makeCtx();
    const failure = vi.fn();
    const error = new Error("invalid audio");
    decode.mockRejectedValueOnce(error);
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      failure,
      vi.fn(),
    );
    engine.setSnapshot(snapshot());
    engine.play(2);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(failure).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        kind: "track",
        hash: "a".repeat(16),
        url: "legacy",
      }),
    );
    setTime(10);
    expect(engine.currentTimeSec()).toBe(2);
    expect(created).toHaveLength(0);
    engine.dispose();
  });

  it("scales a clip by its track's volume envelope, fades riding on it", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const next = snapshot("a".repeat(16), "legacy", 10);
    next.clipsByTrack.host[0].fade_out_ms = 8000;
    engine.setSnapshot({
      ...next,
      volumeByTrack: {
        host: [
          { time: 0, value: 0.5 },
          { time: 20, value: 0.5 },
        ],
      },
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.play(16);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(gains.at(-1)?.gain.setValueAtTime).toHaveBeenCalledWith(0.25, 0);
    expect(gains.at(-1)?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      4,
    );
    engine.dispose();
  });

  it("holds the level before an envelope step and jumps at it", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot({
      ...snapshot("a".repeat(16), "legacy", 10),
      volumeByTrack: {
        host: [
          { time: 13, value: 1 },
          { time: 13, value: 0.5 },
          { time: 15, value: 0.5 },
        ],
      },
      durationSec: Number.POSITIVE_INFINITY,
    });
    engine.play(11);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const ramps = vi.mocked(gains.at(-1)!.gain.linearRampToValueAtTime).mock
      .calls;
    expect(ramps).toContainEqual([1, expect.closeTo(2, 4)]);
    expect(ramps).toContainEqual([0.5, expect.closeTo(2, 4)]);
    expect(ramps.findIndex(([value]) => value === 1)).toBeLessThan(
      ramps.findIndex(([value]) => value === 0.5),
    );
    engine.dispose();
  });

  it("plays a clip through the track of the lane it sits on", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const next = snapshot("a".repeat(16), "legacy", 30);
    Object.assign(next.clipsByTrack.host[0], {
      track_id: "guest",
      origin_track_id: "host",
    });
    next.tracks = [
      { id: "host", gain_db: 0, muted: false },
      { id: "guest", gain_db: 0, muted: true },
    ];
    engine.setSnapshot(next);
    engine.play(1);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const [, hostTrack, guestTrack, clipGain] = gains;
    expect(clipGain.connect).toHaveBeenCalledWith(guestTrack);
    expect(clipGain.connect).not.toHaveBeenCalledWith(hostTrack);
    engine.dispose();
  });

  it("ramps down over a mute region, holds silent, and back up", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const next = snapshot("a".repeat(16), "legacy", 30);
    Object.assign(next.clipsByTrack.host[0], {
      mute_regions: [
        { start_s: 12, end_s: 14, fade_out_ms: 100, fade_in_ms: 100 },
      ],
    });
    engine.setSnapshot(next);
    engine.play(11);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const ramps = vi.mocked(gains.at(-1)!.gain.linearRampToValueAtTime).mock
      .calls;
    expect(ramps).toContainEqual([1, expect.closeTo(1, 4)]);
    expect(ramps).toContainEqual([
      expect.closeTo(0, 4),
      expect.closeTo(1.1, 4),
    ]);
    expect(ramps).toContainEqual([
      expect.closeTo(0, 4),
      expect.closeTo(2.9, 4),
    ]);
    expect(ramps).toContainEqual([1, expect.closeTo(3, 4)]);
    engine.dispose();
  });

  it("continues the absolute fade across chunks and a seek instead of restarting it", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const next = snapshot("a".repeat(16), "legacy", 10);
    next.clipsByTrack.host[0].fade_in_ms = 15000;
    next.clipsByTrack.host[0].fade_out_ms = 8000;
    engine.setSnapshot(next);
    engine.play(11);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].start).toHaveBeenCalledWith(0, 1, 9);
    expect(gains.at(-1)?.gain.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(gains.at(-1)?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      9,
    );
    engine.seek(16);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(gains.at(-1)?.gain.setValueAtTime).toHaveBeenCalledWith(0.5, 0);
    engine.dispose();
  });

  it("connects variant bytes through one clip gain and the supplied output gain once", async () => {
    const { ctx, created, gains } = makeCtx();
    const engine = new ProxyEngine(
      ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    const next = snapshot();
    const id = "b".repeat(64);
    next.manifest = {
      ...next.manifest,
      tracks: {},
      artifacts: { [id]: { ...next.manifest.tracks.host, hash: id } },
      occurrences: {
        c: { artifactId: id, outputTrackId: "host", bakesMutes: true },
      },
    };
    next.tracks[0].gain_db = -6;
    engine.setSnapshot(next);
    engine.play(0);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].connect).toHaveBeenCalledExactlyOnceWith(gains[2]);
    expect(gains[2].connect).toHaveBeenCalledExactlyOnceWith(gains[1]);
    expect(gains[1].gain.value).toBeCloseTo(10 ** (-6 / 20));
    expect(engine.readTrackFrame("host")?.[0]).toBe(0.5);
    engine.dispose();
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

/** Moves the audio clock to `time` and delivers each sentinel `ended` that came due, oldest first. */
async function advanceTo(
  handle: ReturnType<typeof makeCtx>,
  time: number,
): Promise<void> {
  handle.setTime(time);
  for (;;) {
    const due = handle.sentinels
      .filter(
        (node) =>
          !node.fired &&
          node.onended !== null &&
          node.stopAt !== null &&
          node.stopAt <= time,
      )
      .sort((a, b) => (a.stopAt ?? 0) - (b.stopAt ?? 0))[0];
    if (!due) break;
    due.fired = true;
    due.onended?.();
    await flush();
  }
  await flush();
}

function soundingAt(
  created: ReturnType<typeof makeCtx>["created"],
  ctxTime: number,
  rate: number,
): number {
  return created.filter(({ start, stop }) => {
    const [when, , duration] = start.mock.calls[0] ?? [];
    return (
      stop.mock.calls.length === 0 &&
      when <= ctxTime &&
      ctxTime < when + duration / rate
    );
  }).length;
}

function episode(durationSec: number, chunkSec = 60) {
  const chunkCount = Math.ceil(durationSec / chunkSec);
  return {
    manifest: {
      revision: "long",
      project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
      tracks: {
        host: {
          hash: "a".repeat(16),
          chunk_sec: chunkSec,
          overlap_ms: 200,
          chunk_count: chunkCount,
          duration_sec: durationSec,
          urls: Array.from({ length: chunkCount }, (_, i) => `c${i}`),
        },
      },
      artifacts: {},
      occurrences: {},
    } as ProxyManifest,
    clipsByTrack: {
      host: [
        {
          id: "c",
          track_id: "host",
          source_start: 0,
          source_end: durationSec,
          timeline_start: 0,
          timeline_end: durationSec,
          fade_in_ms: 0,
          fade_out_ms: 0,
          join_in_mode: "fade" as const,
          source_id: null,
          source_duration_sec: null,
          recording_key: null,
        },
      ],
    },
    tracks: [{ id: "host", gain_db: 0, muted: false }],
    durationSec,
  };
}

describe("playing a timeline longer than the first window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([1, 4])(
    "keeps exactly one source sounding to the end of a 400 s clip at %ix",
    async (rate) => {
      const handle = makeCtx();
      const fetchChunk = vi.fn(async () => new ArrayBuffer(64));
      const engine = new ProxyEngine(handle.ctx, fetchChunk, vi.fn(), vi.fn());
      engine.setSnapshot(episode(400));
      engine.setPlaybackRate(rate);
      engine.play(0);
      await flush();
      for (let ctxSec = 1; ctxSec + 0.5 < 400 / rate; ctxSec += 1) {
        await advanceTo(handle, ctxSec);
        expect(
          soundingAt(handle.created, ctxSec + 0.5, rate),
          `sources sounding at ctx ${ctxSec + 0.5} s (timeline ${(ctxSec + 0.5) * rate} s)`,
        ).toBe(1);
      }
      expect(handle.created).toHaveLength(7);
      expect(
        new Set(handle.created.map(({ start }) => start.mock.calls[0][0])).size,
      ).toBe(7);
      expect(fetchChunk).toHaveBeenCalledTimes(7);
      engine.dispose();
    },
  );

  it("ends the episode from the audio clock without a frame callback", async () => {
    vi.stubGlobal("requestAnimationFrame", () => {
      throw new Error("the engine must not use requestAnimationFrame");
    });
    const handle = makeCtx();
    const onEnded = vi.fn();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      onEnded,
    );
    engine.setSnapshot(episode(130));
    engine.play(0);
    await flush();
    for (let ctxSec = 1; ctxSec < 130; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    expect(onEnded).not.toHaveBeenCalled();
    await advanceTo(handle, 130);
    expect(onEnded).toHaveBeenCalledExactlyOnceWith(130);
    expect(handle.suspend).toHaveBeenCalled();
    const sourcesAtEnd = handle.created.length;
    await advanceTo(handle, 140);
    expect(engine.currentTimeSec()).toBe(130);
    expect(handle.created).toHaveLength(sourcesAtEnd);
    expect(engine.readTrackFrame("host")).toBeNull();
    expect(onEnded).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("abuts the next batch to the slice that straddles the old edge and starts that slice once", async () => {
    const handle = makeCtx();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot(episode(250, 50));
    engine.play(0);
    await flush();
    for (let ctxSec = 1; ctxSec <= 200; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    const starts = handle.created.map(({ start }) => start.mock.calls[0]);
    expect(starts.map(([when]) => when)).toEqual([0, 50, 100, 150, 200]);
    for (let i = 1; i < starts.length; i += 1) {
      const [previousWhen, , previousDuration] = starts[i - 1];
      expect(
        Math.abs(previousWhen + previousDuration - starts[i][0]),
      ).toBeLessThan(1e-9);
    }
    engine.dispose();
  });

  describe("while an extension is still fetching", () => {
    async function playUntilExtensionPending(rate = 1) {
      const handle = makeCtx();
      const gate = deferred<ArrayBuffer>();
      const fetchChunk = vi.fn((ref: ImmutableChunkRef) =>
        ref.index === 2 ? gate.promise : Promise.resolve(new ArrayBuffer(64)),
      );
      const failure = vi.fn();
      const onEnded = vi.fn();
      const engine = new ProxyEngine(handle.ctx, fetchChunk, failure, onEnded);
      engine.setSnapshot(episode(400));
      engine.setPlaybackRate(rate);
      engine.play(0);
      await flush();
      for (let ctxSec = 1; ctxSec <= 75; ctxSec += 1) {
        await advanceTo(handle, ctxSec);
      }
      expect(fetchChunk.mock.calls.some(([ref]) => ref.index === 2)).toBe(true);
      return { handle, engine, gate, failure, onEnded };
    }

    it("places nothing from the extension after a seek", async () => {
      const { handle, engine, gate, failure, onEnded } =
        await playUntilExtensionPending();
      engine.seek(300);
      await flush();
      const created = handle.created.length;
      gate.resolve(new ArrayBuffer(64));
      await flush();
      expect(handle.created).toHaveLength(created);
      for (let ctxSec = 76; ctxSec < 75 + 99; ctxSec += 1) {
        await advanceTo(handle, ctxSec);
        expect(
          soundingAt(handle.created, ctxSec + 0.5, 1),
          `sources sounding at ctx ${ctxSec + 0.5} s`,
        ).toBe(1);
      }
      expect(failure).not.toHaveBeenCalled();
      expect(onEnded).not.toHaveBeenCalled();
      engine.dispose();
    });

    it("places nothing from the extension after a pause", async () => {
      const { handle, engine, gate, failure, onEnded } =
        await playUntilExtensionPending();
      const created = handle.created.length;
      engine.pause();
      gate.resolve(new ArrayBuffer(64));
      await flush();
      await advanceTo(handle, 200);
      expect(handle.created).toHaveLength(created);
      expect(engine.readTrackFrame("host")).toBeNull();
      expect(failure).not.toHaveBeenCalled();
      expect(onEnded).not.toHaveBeenCalled();
      engine.dispose();
    });

    it("places nothing from the extension after a rate change, which reschedules on its own", async () => {
      const { handle, engine, gate, failure, onEnded } =
        await playUntilExtensionPending();
      engine.setPlaybackRate(2);
      gate.resolve(new ArrayBuffer(64));
      await flush();
      const live = handle.created.filter(
        ({ stop }) => stop.mock.calls.length === 0,
      );
      expect(
        new Set(live.map(({ start }) => start.mock.calls[0][1])).size,
      ).toBe(live.length);
      expect(soundingAt(handle.created, 76.5, 2)).toBe(1);
      expect(failure).not.toHaveBeenCalled();
      expect(onEnded).not.toHaveBeenCalled();
      engine.dispose();
    });

    it("stops everything once and wakes nothing when the extension's fetch fails", async () => {
      const { handle, engine, gate, failure, onEnded } =
        await playUntilExtensionPending();
      const error = new TypeError("Failed to fetch");
      expect(soundingAt(handle.created, 75.5, 1)).toBe(1);
      gate.reject(error);
      await flush();
      expect(failure).toHaveBeenCalledExactlyOnceWith(
        error,
        expect.objectContaining({ index: 2 }),
      );
      expect(soundingAt(handle.created, 75.5, 1)).toBe(0);
      const created = handle.created.length;
      await advanceTo(handle, 200);
      expect(handle.created).toHaveLength(created);
      expect(engine.currentTimeSec()).toBe(75);
      expect(onEnded).not.toHaveBeenCalled();
      engine.dispose();
    });
  });

  it("after a late wake fetches nothing that already ended and resumes in sync", async () => {
    const handle = makeCtx();
    const fetchChunk = vi.fn(
      async (_ref: ImmutableChunkRef) => new ArrayBuffer(64),
    );
    const engine = new ProxyEngine(handle.ctx, fetchChunk, vi.fn(), vi.fn());
    engine.setSnapshot(episode(400));
    engine.play(0);
    await flush();
    await advanceTo(handle, 330);
    expect(fetchChunk.mock.calls.map(([ref]) => ref.index).sort()).toEqual([
      0, 1, 5, 6,
    ]);
    expect(handle.created.map(({ start }) => start.mock.calls[0][0])).toEqual([
      0, 60, 330, 360,
    ]);
    for (let ctxSec = 330; ctxSec + 0.5 < 400; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
      expect(
        soundingAt(handle.created, ctxSec + 0.5, 1),
        `sources sounding at ctx ${ctxSec + 0.5} s`,
      ).toBe(1);
    }
    const [when, offset, duration] = handle.created[2].start.mock.calls[0];
    expect(when).toBe(330);
    expect(offset).toBeCloseTo(30.2, 9);
    expect(duration).toBe(30);
    engine.dispose();
  });

  it("places a clip that starts and one that ends exactly on a batch edge once each", async () => {
    const handle = makeCtx();
    const base = episode(240);
    const guestChunks = 5;
    const clip = (id: string, trackId: string, start: number, end: number) => ({
      ...base.clipsByTrack.host[0],
      id,
      track_id: trackId,
      source_start: start,
      source_end: end,
      timeline_start: start,
      timeline_end: end,
    });
    const engine = new ProxyEngine(
      handle.ctx,
      async (ref) => new ArrayBuffer(ref.url.startsWith("g") ? 96 : 64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        tracks: {
          host: base.manifest.tracks.host,
          guest: {
            ...base.manifest.tracks.host,
            chunk_count: guestChunks,
            duration_sec: 300,
            urls: Array.from({ length: guestChunks }, (_, i) => `g${i}`),
          },
        },
      },
      clipsByTrack: {
        host: [clip("h", "host", 0, 240)],
        guest: [clip("a", "guest", 0, 120), clip("b", "guest", 120, 300)],
      },
      tracks: [
        { id: "host", gain_db: 0, muted: false },
        { id: "guest", gain_db: 0, muted: false },
      ],
      durationSec: 300,
    });
    engine.play(0);
    await flush();
    for (let ctxSec = 1; ctxSec <= 250; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    const whens = (bufferLength: number) =>
      handle.created
        .filter(({ buffer }) => buffer?.length === bufferLength)
        .map(({ start }) => start.mock.calls[0][0])
        .sort((a, b) => a - b);
    expect(whens(64)).toEqual([0, 60, 120, 180]);
    expect(whens(96)).toEqual([0, 60, 120, 180, 240]);
    engine.dispose();
  });

  it("keeps one source sounding to the end across a rate change after an extension", async () => {
    const handle = makeCtx();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot(episode(400));
    engine.play(0);
    await flush();
    for (let ctxSec = 1; ctxSec <= 130; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    const oldSentinel = handle.sentinels.filter(({ fired }) => !fired).at(-1);
    engine.setPlaybackRate(2);
    await flush();
    expect(oldSentinel?.onended).toBeNull();
    for (let ctxSec = 131; ctxSec + 0.5 < 130 + 135; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
      expect(
        soundingAt(handle.created, ctxSec + 0.5, 2),
        `sources sounding at ctx ${ctxSec + 0.5} s`,
      ).toBe(1);
    }
    expect(oldSentinel?.fired).toBe(false);
    engine.dispose();
  });

  it("disconnects each source once it has finished and keeps the ones still to sound", async () => {
    const handle = makeCtx();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot(episode(400));
    engine.play(0);
    await flush();
    for (let ctxSec = 1; ctxSec <= 76; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    expect(handle.created[0].disconnect).toHaveBeenCalled();
    expect(handle.created[1].disconnect).not.toHaveBeenCalled();
    for (let ctxSec = 77; ctxSec <= 196; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    expect(handle.created[1].disconnect).toHaveBeenCalled();
    expect(handle.created.at(-1)?.disconnect).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("ends an empty timeline at once, reporting the end exactly once", async () => {
    const handle = makeCtx();
    const onEnded = vi.fn();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      onEnded,
    );
    engine.setSnapshot({ ...episode(60), clipsByTrack: {}, durationSec: 0 });
    engine.play(0);
    await flush();
    await advanceTo(handle, 5);
    expect(onEnded).toHaveBeenCalledExactlyOnceWith(0);
    expect(handle.created).toHaveLength(0);
    engine.dispose();
  });

  it("leaves the playback session when the episode ends", async () => {
    const handle = makeCtx();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      vi.fn(),
    );
    engine.setSnapshot(episode(130));
    engine.play(0);
    await flush();
    vi.mocked(leavePlaybackSession).mockClear();
    for (let ctxSec = 1; ctxSec <= 130; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    expect(leavePlaybackSession).toHaveBeenCalled();
    engine.dispose();
  });

  it("ends at a later duration that arrives in a snapshot while playing", async () => {
    const handle = makeCtx();
    const onEnded = vi.fn();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      onEnded,
    );
    engine.setSnapshot(episode(20));
    engine.play(0);
    await flush();
    await advanceTo(handle, 10);
    engine.setSnapshot({ ...episode(20), durationSec: 40 });
    await flush();
    for (let ctxSec = 11; ctxSec < 40; ctxSec += 1) {
      await advanceTo(handle, ctxSec);
    }
    expect(onEnded).not.toHaveBeenCalled();
    await advanceTo(handle, 40);
    expect(onEnded).toHaveBeenCalledExactlyOnceWith(40);
    engine.dispose();
  });

  describe("when the stored duration is shorter than the last clip", () => {
    const stale = () => ({ ...episode(30), durationSec: 20 });

    it("sounds to the clip end and reports the end there", async () => {
      const handle = makeCtx();
      const onEnded = vi.fn();
      const engine = new ProxyEngine(
        handle.ctx,
        async () => new ArrayBuffer(64),
        vi.fn(),
        onEnded,
      );
      engine.setSnapshot(stale());
      engine.play(0);
      await flush();
      for (let ctxSec = 1; ctxSec <= 29; ctxSec += 1) {
        await advanceTo(handle, ctxSec);
      }
      expect(soundingAt(handle.created, 25.5, 1)).toBe(1);
      expect(onEnded).not.toHaveBeenCalled();
      await advanceTo(handle, 30);
      expect(onEnded).toHaveBeenCalledExactlyOnceWith(30);
      engine.dispose();
    });

    it("plays from a position past the stored duration instead of restarting", async () => {
      const handle = makeCtx();
      const engine = new ProxyEngine(
        handle.ctx,
        async () => new ArrayBuffer(64),
        vi.fn(),
        vi.fn(),
      );
      engine.setSnapshot(stale());
      engine.play(25);
      await flush();
      expect(engine.currentTimeSec()).toBe(25);
      expect(handle.created[0].start).toHaveBeenCalledWith(0, 25, 5);
      engine.dispose();
    });
  });

  it("starts over from the beginning when Play is pressed at the end", async () => {
    const handle = makeCtx();
    const onEnded = vi.fn();
    const engine = new ProxyEngine(
      handle.ctx,
      async () => new ArrayBuffer(64),
      vi.fn(),
      onEnded,
    );
    engine.setSnapshot(episode(130));
    engine.play(130);
    await flush();
    expect(engine.currentTimeSec()).toBe(0);
    expect(handle.created[0].start).toHaveBeenCalledWith(0, 0, 60);
    expect(onEnded).not.toHaveBeenCalled();
    engine.dispose();
  });
});
