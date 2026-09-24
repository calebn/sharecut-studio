import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_CLIP_DB } from "../audio/metering";
import { type FrameReader, usePeakMeter } from "../audio/usePeakMeter";
import { dbToLinear } from "../utils/audio";
import { acquireMeterContext } from "./sharedMeterContext";

export type InputPeakLevels = ReturnType<typeof usePeakMeter> & {
  /** The AudioContext is not running; call resume() from a user gesture. */
  suspended: boolean;
  resume: () => void;
};

type Options = {
  /** Sample-peak dBFS that latches the clip indicator. Defaults to −1. */
  clipDb?: number;
};

type MeterMessage = {
  type?: "clearAck";
  peak?: number;
  clipped?: boolean;
  epoch: number;
};

const MIN_PEAK_REPORT_TIMEOUT_MS = 100;
const REPORT_BLOCKS = 8;
const RENDER_QUANTUM_FRAMES = 128;

function peakReportTimeoutMs(sampleRate: number): number {
  // Keep a report visible across at least two batches at low sample rates.
  return Math.max(
    MIN_PEAK_REPORT_TIMEOUT_MS,
    (2 * REPORT_BLOCKS * RENDER_QUANTUM_FRAMES * 1000) / sampleRate,
  );
}

function retireNode(node: AudioWorkletNode | null): void {
  if (!node) return;
  node.port.onmessage = null;
  node.port.postMessage({ type: "stop" });
  node.port.close();
  node.disconnect();
}

/**
 * Drive a LevelMeter from a mic stream. The worklet inspects every render
 * block, including blocks processed while animation frames are throttled.
 * Its sticky clip report is committed immediately; rAF only controls the
 * visible level and PPM-style peak hold. Stream changes reset both latches.
 */
export function useInputPeakDb(
  stream: MediaStream | null,
  { clipDb = DEFAULT_CLIP_DB }: Options = {},
): InputPeakLevels {
  const [reader, setReader] = useState<FrameReader | null>(null);
  const [suspended, setSuspended] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const epochRef = useRef(0);
  const pendingPeakRef = useRef(0);
  const latestPeakRef = useRef(0);
  const peakReceivedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const frameRef = useRef(new Float32Array(1));
  const levels = usePeakMeter(reader, { clipDb });
  const latchClip = levels.latchClip;
  const clearMeterClip = levels.clearClip;

  useEffect(() => {
    setReader(null);
    setSuspended(false);
    epochRef.current = 0;
    pendingPeakRef.current = 0;
    latestPeakRef.current = 0;
    peakReceivedAtRef.current = Number.NEGATIVE_INFINITY;
    if (!stream) return;
    let active = true;
    let ctx: AudioContext | null = null;
    let release: (() => void) | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let node: AudioWorkletNode | null = null;
    let silent: GainNode | null = null;
    const onStateChange = () => {
      if (active && ctx) setSuspended(ctx.state !== "running");
    };

    const open = async () => {
      try {
        const acquired = acquireMeterContext();
        if (!acquired) return;
        ctx = acquired.ctx;
        release = acquired.release;
        const reportTimeoutMs = peakReportTimeoutMs(ctx.sampleRate);
        ctxRef.current = ctx;
        ctx.addEventListener("statechange", onStateChange);
        onStateChange();
        // Autoplay policy may suspend this until a user invokes resume().
        void ctx.resume().catch(() => undefined);
        await acquired.ready;
        if (!active) return;
        source = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, "sharecut-input-meter", {
          processorOptions: { clipThreshold: dbToLinear(clipDb) },
        });
        epochRef.current = 0;
        silent = ctx.createGain();
        silent.gain.value = 0;
        node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
          const data = event.data;
          if (!active || data.epoch !== epochRef.current) return;
          if (data.type === "clearAck") {
            if (data.clipped) latchClip();
            return;
          }
          latestPeakRef.current = data.peak ?? 0;
          pendingPeakRef.current = Math.max(
            pendingPeakRef.current,
            latestPeakRef.current,
          );
          peakReceivedAtRef.current = performance.now();
          if (data.clipped) latchClip();
        };
        portRef.current = node.port;
        source.connect(node);
        node.connect(silent);
        silent.connect(ctx.destination);
        setReader(() => () => {
          const freshPeak =
            performance.now() - peakReceivedAtRef.current <= reportTimeoutMs
              ? latestPeakRef.current
              : 0;
          frameRef.current[0] = Math.max(pendingPeakRef.current, freshPeak);
          pendingPeakRef.current = 0;
          return frameRef.current;
        });
      } catch {
        if (!active) return;
        // Missing audio track, unsupported worklet, or context limit.
        portRef.current = null;
        ctxRef.current = null;
        setSuspended(false);
        setReader(null);
        source?.disconnect();
        retireNode(node);
        silent?.disconnect();
        if (ctx) {
          ctx.removeEventListener("statechange", onStateChange);
          release?.();
          release = null;
          ctx = null;
        }
      }
    };
    void open();

    return () => {
      active = false;
      portRef.current = null;
      ctxRef.current = null;
      if (!ctx) return;
      ctx.removeEventListener("statechange", onStateChange);
      source?.disconnect();
      retireNode(node);
      silent?.disconnect();
      release?.();
    };
  }, [stream, clipDb, latchClip]);

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx) void ctx.resume().catch(() => undefined);
  }, []);

  const clearClip = useCallback(() => {
    const ctx = ctxRef.current;
    const clearFrame = ctx ? Math.round(ctx.currentTime * ctx.sampleRate) : 0;
    epochRef.current += 1;
    pendingPeakRef.current = 0;
    latestPeakRef.current = 0;
    peakReceivedAtRef.current = Number.NEGATIVE_INFINITY;
    portRef.current?.postMessage({
      type: "clear",
      epoch: epochRef.current,
      clearFrame,
    });
    clearMeterClip();
  }, [clearMeterClip]);

  return { ...levels, clearClip, suspended, resume };
}
