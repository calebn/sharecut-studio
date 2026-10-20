import { describe, expect, it, vi } from "vitest";
import type { ClipRow } from "../types/project";
import { ProxyEngine } from "./proxyEngine";
import type { ImmutableChunkRef, ProxyManifest } from "./proxyMath";

function makeCtx() {
  const created: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    playbackRate: { value: number };
    buffer: AudioBuffer | null;
    connect: ReturnType<typeof vi.fn>;
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
    engine.setSnapshot({ manifest, clipsByTrack: {}, tracks: [] });
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
    );
    engine.setSnapshot({
      manifest,
      clipsByTrack: {},
      tracks: [
        { id: "host", gain_db: -2, fader_db: -4, muted: false },
        { id: "guest", gain_db: 0, muted: true },
        { id: "cohost", gain_db: 0, muted: false },
      ],
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
    const engine = new ProxyEngine(ctx, fetch, vi.fn());
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
    const engine = new ProxyEngine(ctx, fetch, failure);
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
    const engine = new ProxyEngine(ctx, fetch, vi.fn());
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
    const engine = new ProxyEngine(ctx, () => pending.promise, failure);
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
    );
    const next = snapshot();
    const id = "b".repeat(64);
    next.manifest = {
      ...next.manifest,
      tracks: {},
      artifacts: { [id]: { ...next.manifest.tracks.host, hash: id } },
      occurrences: { c: { artifactId: id, outputTrackId: "host" } },
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
