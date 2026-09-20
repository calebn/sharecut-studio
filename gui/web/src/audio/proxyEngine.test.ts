import { describe, expect, it, vi } from "vitest";
import type { ClipRow } from "../types/project";
import { ProxyEngine } from "./proxyEngine";

function makeCtx() {
  const created: Array<{ start: (...args: unknown[]) => void }> = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => {
      const gain = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
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
  return { ctx: ctx as unknown as AudioContext, created };
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
});
