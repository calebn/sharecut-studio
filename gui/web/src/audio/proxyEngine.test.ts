import { describe, expect, it, vi } from "vitest";
import type { ClipRow } from "../types/project";
import { ProxyEngine } from "./proxyEngine";

function makeCtx() {
  const created: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    playbackRate: { value: number };
  }> = [];
  const gains: Array<{
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
    decodeAudioData: async (ab: ArrayBuffer) =>
      ({
        length: ab.byteLength || 48000,
        duration: 1,
        numberOfChannels: 1,
        sampleRate: 48000,
      }) as AudioBuffer,
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    ctx: ctx as unknown as AudioContext,
    created,
    gains,
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
    const engine = new ProxyEngine(ctx, async () => new ArrayBuffer(64));
    engine.setManifest({
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
    });
    engine.setProject({}, [{ id: "host", gain_db: 6, muted: false }]);
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
    engine.setProject({}, []);
    expect(split?.disconnect).toHaveBeenCalledOnce();
    expect(engine.readTrackFrame("host")).toBeNull();
    engine.pause();
    expect(suspend).toHaveBeenCalled();
    engine.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("schedules sources for clips in the window", async () => {
    const { ctx, created } = makeCtx();
    const engine = new ProxyEngine(ctx, async () => new ArrayBuffer(64));
    engine.setManifest({
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
    });
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
      },
    ];
    engine.setProject({ host: clips }, [
      { id: "host", gain_db: 0, muted: false },
    ]);
    engine.play(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(created.length).toBeGreaterThan(0);
    expect(created[0].start).toHaveBeenCalled();
    engine.dispose();
  });

  it("plays each track at its output gain; the saved mute beats solo", () => {
    const { ctx, gains } = makeCtx();
    const engine = new ProxyEngine(ctx, async () => new ArrayBuffer(64));
    engine.setProject({}, [
      { id: "host", gain_db: -2, fader_db: -4, muted: false },
      { id: "guest", gain_db: 0, muted: true },
      { id: "cohost", gain_db: 0, muted: false },
    ]);
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
    const engine = new ProxyEngine(ctx, async () => new ArrayBuffer(64));
    engine.setManifest({
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
    });
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
        },
      ],
    };
    engine.setProject(clips, [{ id: "host", gain_db: 0, muted: false }]);
    engine.play(0);
    await new Promise((r) => setTimeout(r, 20));
    const scheduled = created.length;
    expect(scheduled).toBeGreaterThan(0);

    // A full snapshot's fresh but equal clips don't reschedule either.
    engine.setProject(structuredClone(clips), [
      { id: "host", gain_db: 0, fader_db: -6, muted: false },
    ]);
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
    const engine = new ProxyEngine(ctx, async () => new ArrayBuffer(64));
    engine.setManifest({
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
    });
    engine.setProject(
      {
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
          },
        ],
      },
      [{ id: "host", gain_db: 0, muted: false }],
    );
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
    );
    engine.setManifest({
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
    });
    engine.setProject(
      {
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
          },
        ],
      },
      [{ id: "host", gain_db: 0, muted: false }],
    );
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
