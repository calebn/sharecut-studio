import { describe, expect, it, vi } from "vitest";
import type { ClipRow } from "../types/project";
import { ProxyEngine } from "./proxyEngine";

function makeCtx() {
  const created: Array<{ start: (...args: unknown[]) => void }> = [];
  const gains: Array<{
    gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> };
  }> = [];
  const ctx = {
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
  };
  return { ctx: ctx as unknown as AudioContext, created, gains };
}

describe("ProxyEngine", () => {
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

    engine.setProject(clips, [
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
});
