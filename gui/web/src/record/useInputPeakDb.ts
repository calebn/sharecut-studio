import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CLIP_DB,
  decayPeakHold,
  peakDbFromSamples,
} from "../ui/metering";

export type InputPeakLevels = {
  /** Current peak input level, dBFS (−Infinity when silent). */
  levelDb: number;
  /** PPM-style peak hold, dBFS. */
  peakHoldDb: number;
  /** Latched: once a peak hits `clipDb`, stays true until `clearClip()`. */
  clipped: boolean;
  clearClip: () => void;
};

type Options = {
  /**
   * Sample-peak dBFS that latches the clip indicator. Defaults to −1: sample
   * peaks under-read inter-sample (true) peaks, so latching a hair below
   * 0 dBFS is the conservative choice (cf. the −1 dBTP production ceiling).
   */
  clipDb?: number;
};

/**
 * Drive a LevelMeter from a mic MediaStream.
 *
 * Reads time-domain frames off an AnalyserNode each animation frame, takes
 * the true peak (not RMS — this meter is overload protection), and maintains
 * a PPM-style peak hold plus a latching clip flag. Returns the exact state
 * shape the LevelMeter stories demonstrate, so the record lobby and the
 * per-participant record-room rows can wire it with no translation.
 */
export function useInputPeakDb(
  stream: MediaStream | null,
  { clipDb = DEFAULT_CLIP_DB }: Options = {},
): InputPeakLevels {
  const [levelDb, setLevelDb] = useState<number>(Number.NEGATIVE_INFINITY);
  const [peakHoldDb, setPeakHoldDb] = useState<number>(
    Number.NEGATIVE_INFINITY,
  );
  const [clipped, setClipped] = useState(false);
  const holdRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (!stream) return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const frame = new Float32Array(analyser.fftSize);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      analyser.getFloatTimeDomainData(frame);
      const peak = peakDbFromSamples(frame);
      holdRef.current = decayPeakHold(holdRef.current, peak, now - last);
      last = now;
      setLevelDb(peak);
      setPeakHoldDb(holdRef.current);
      if (peak >= clipDb) setClipped(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close();
    };
  }, [stream, clipDb]);

  const clearClip = useCallback(() => setClipped(false), []);

  return { levelDb, peakHoldDb, clipped, clearClip };
}
