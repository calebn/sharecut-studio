import type { FrameReader } from "../audio/usePeakMeter";
import { dbToLinear } from "../utils/audio";

type Sample = { startedAt: number; frame: Float32Array };
export type MeterStorySource = {
  attach: () => void;
  dispose: () => void;
  read: FrameReader;
};
const EMPTY_FRAME = new Float32Array(0);

function meterSource(
  length: number,
  cycles: number,
  level: (now: number, startedAt: number) => number,
): MeterStorySource {
  let sample: Sample | null = null;
  return {
    attach() {
      sample = {
        startedAt: performance.now(),
        frame: new Float32Array(length),
      };
    },
    dispose() {
      sample = null;
    },
    read() {
      if (sample === null) return EMPTY_FRAME;
      const amp = dbToLinear(level(performance.now(), sample.startedAt));
      const frame = sample.frame;
      for (let i = 0; i < frame.length; i++)
        frame[i] = amp * Math.sin((i / frame.length) * Math.PI * cycles);
      return frame;
    },
  };
}

export function createScriptedMeterSource(): MeterStorySource {
  return meterSource(2048, 8, (now, startedAt) => {
    const cyc = ((now - startedAt) / 1000) % 16;
    if (cyc < 2) return -48 + Math.random() * 4;
    if (cyc < 8) return -16 + Math.sin(cyc * 7) * 4 + Math.random() * 5;
    if (cyc < 8.5) return -0.5 + Math.random() * 1.2;
    return -16 + Math.sin(cyc * 6.3) * 4 + Math.random() * 5;
  });
}

export function createParticipantMeterSource(
  seed: number,
  clipAt: number | null,
): MeterStorySource {
  return meterSource(1024, 6, (now) => {
    const t = now / 1000;
    let target =
      -18 +
      Math.sin(t * 5 + seed) * 3 +
      Math.sin(t * 11 + seed * 2) * 2 +
      Math.random() * 4;
    if (clipAt !== null && t % 20 > clipAt && t % 20 < clipAt + 0.4)
      target = -0.3;
    return target;
  });
}
