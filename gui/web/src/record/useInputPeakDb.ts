import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FrameReader,
  type PeakMeterLevels,
  usePeakMeter,
} from "../audio/usePeakMeter";
import { audioContextCtor } from "../utils/audio";

/**
 * Analyser window. At 48 kHz this is ~85 ms, so consecutive animation frames
 * overlap even under ~30 fps throttling and a transient between frames is
 * still inspected. Hidden tabs pause rAF entirely; see the hook's docs.
 */
export const INPUT_METER_FFT_SIZE = 4096;

export type InputPeakLevels = PeakMeterLevels & {
  /**
   * The AudioContext is not running (autoplay policy, iOS interruption), so
   * the meter reads silence. Show a "tap to enable meter" affordance that
   * calls `resume()` from the gesture.
   */
  suspended: boolean;
  /** Resume the metering AudioContext; call from a user gesture. */
  resume: () => void;
};

type Options = {
  /**
   * Sample-peak dBFS that latches the clip indicator. Defaults to −1: sample
   * peaks under-read inter-sample (true) peaks, so latching a hair below
   * 0 dBFS is the conservative choice (cf. the −1 dBTP production ceiling).
   */
  clipDb?: number;
};

function closeQuietly(ctx: AudioContext): void {
  void ctx.close().catch(() => undefined);
}

/**
 * Drive a LevelMeter from a mic MediaStream.
 *
 * Builds an AnalyserNode graph for `stream` and hands its frames to
 * `usePeakMeter`, which takes the sample peak (not RMS — this meter is
 * overload protection) and maintains a PPM-style peak hold plus a latching
 * clip flag. The meter resets whenever `stream` changes or goes `null`.
 *
 * Limitation: the clip latch only sees what each animation frame reads. rAF
 * stops in hidden tabs, so a clip while the tab is hidden is not latched
 * (tracked: AudioWorklet-based detection, #203).
 */
export function useInputPeakDb(
  stream: MediaStream | null,
  { clipDb }: Options = {},
): InputPeakLevels {
  const [reader, setReader] = useState<FrameReader | null>(null);
  const [suspended, setSuspended] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setReader(null);
    setSuspended(false);
    if (!stream) return;
    const AC = audioContextCtor();
    if (!AC) return;

    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    const onStateChange = () => {
      if (ctx) setSuspended(ctx.state !== "running");
    };
    try {
      ctx = new AC();
      source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = INPUT_METER_FFT_SIZE;
      source.connect(analyser);
      const frame = new Float32Array(analyser.fftSize);
      ctx.addEventListener("statechange", onStateChange);
      onStateChange();
      // Created outside a gesture, so autoplay policy may start it suspended.
      void ctx.resume().catch(() => undefined);
      ctxRef.current = ctx;
      setReader(() => () => {
        analyser.getFloatTimeDomainData(frame);
        return frame;
      });
    } catch {
      // No audio track, ended track, or the per-page context limit: stay
      // inert rather than crash, and never leak the context we opened.
      source?.disconnect();
      if (ctx) closeQuietly(ctx);
      ctx = null;
      source = null;
    }

    return () => {
      ctxRef.current = null;
      if (!ctx) return;
      ctx.removeEventListener("statechange", onStateChange);
      source?.disconnect();
      closeQuietly(ctx);
    };
  }, [stream]);

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx) void ctx.resume().catch(() => undefined);
  }, []);

  const levels = usePeakMeter(reader, { clipDb });
  return { ...levels, suspended, resume };
}
