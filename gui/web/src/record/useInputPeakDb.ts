import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_CLIP_DB } from "../audio/metering";
import { type FrameReader, usePeakMeter } from "../audio/usePeakMeter";
import { audioContextCtor, dbToLinear } from "../utils/audio";
import inputMeterProcessorUrl from "./inputMeterProcessor.js?url";

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
  hotBlocks: number;
};

const PEAK_REPORT_TIMEOUT_MS = 100;

function closeQuietly(ctx: AudioContext): void {
  void ctx.close().catch(() => undefined);
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
  const hotBlocksRef = useRef(0);
  const clearHotBlocksRef = useRef(0);
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
    hotBlocksRef.current = 0;
    clearHotBlocksRef.current = 0;
    if (!stream) return;
    const AC = audioContextCtor();
    if (!AC) return;

    let active = true;
    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let node: AudioWorkletNode | null = null;
    let silent: GainNode | null = null;
    const onStateChange = () => {
      if (active && ctx) setSuspended(ctx.state !== "running");
    };

    const open = async () => {
      try {
        ctx = new AC();
        ctxRef.current = ctx;
        ctx.addEventListener("statechange", onStateChange);
        onStateChange();
        // Autoplay policy may suspend this until a user invokes resume().
        void ctx.resume().catch(() => undefined);
        await ctx.audioWorklet.addModule(inputMeterProcessorUrl);
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
            // Preserve an overload processed after the user's clear action
            // while the clear command was still in flight to the worklet.
            if (data.hotBlocks > clearHotBlocksRef.current) latchClip();
            hotBlocksRef.current = data.hotBlocks;
            return;
          }
          hotBlocksRef.current = data.hotBlocks;
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
            performance.now() - peakReceivedAtRef.current <=
            PEAK_REPORT_TIMEOUT_MS
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
        node?.disconnect();
        silent?.disconnect();
        if (ctx) {
          ctx.removeEventListener("statechange", onStateChange);
          closeQuietly(ctx);
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
      if (node) node.port.onmessage = null;
      source?.disconnect();
      node?.disconnect();
      silent?.disconnect();
      closeQuietly(ctx);
    };
  }, [stream, clipDb, latchClip]);

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx) void ctx.resume().catch(() => undefined);
  }, []);

  const clearClip = useCallback(() => {
    epochRef.current += 1;
    pendingPeakRef.current = 0;
    latestPeakRef.current = 0;
    peakReceivedAtRef.current = Number.NEGATIVE_INFINITY;
    clearHotBlocksRef.current = hotBlocksRef.current;
    portRef.current?.postMessage({ type: "clear", epoch: epochRef.current });
    clearMeterClip();
  }, [clearMeterClip]);

  return { ...levels, clearClip, suspended, resume };
}
