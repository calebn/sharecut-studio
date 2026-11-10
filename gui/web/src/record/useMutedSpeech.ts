import { useEffect, useRef, useState } from "react";
import {
  MUTED_SPEECH_INITIAL,
  type MutedSpeechState,
  mutedSpeechGate,
} from "./alertGates";
import { createMutedSpeechTap } from "./mutedSpeechTap";
import { acquireMeterContext } from "./sharedMeterContext";

const POLL_MS = 100;

type Options = {
  muted: boolean;
  /** The take is recording; false (paused) freezes the count. */
  counting: boolean;
  /** A take is recording or paused; false (lobby, stopped) drops the tap and the count. */
  onAir: boolean;
};

/**
 * True once the mic has heard 10 s of speech while muted (`mutedSpeechGate`).
 * The tap on a mic clone exists only while muted and on air; unmute, take stop,
 * unmount or a new stream drops it and resets the count (a pause only freezes
 * it). If it cannot start, this stays false.
 */
export function useMutedSpeech(
  stream: MediaStream | null,
  { muted, counting, onAir }: Options,
): boolean {
  const [speech, setSpeech] = useState(false);
  const countingRef = useRef(counting);
  countingRef.current = counting;
  const listening = muted && onAir && stream !== null;

  useEffect(() => {
    if (!listening || !stream) return;
    let active = true;
    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let tap: ReturnType<typeof createMutedSpeechTap> = null;
    let gate: MutedSpeechState = MUTED_SPEECH_INITIAL;

    const open = async () => {
      try {
        const acquired = acquireMeterContext();
        if (!acquired) return;
        release = acquired.release;
        void acquired.ctx.resume().catch(() => undefined);
        await acquired.ready;
        if (!active) return;
        tap = createMutedSpeechTap(acquired.ctx, stream);
        if (!tap) return;
        const reading = tap;
        timer = setInterval(() => {
          gate = mutedSpeechGate(gate, {
            nowMs: performance.now(),
            levelDb: reading.readDb(),
            counting: countingRef.current,
          });
          setSpeech(gate.fired);
        }, POLL_MS);
      } catch {
        tap = null;
      }
    };
    void open();

    return () => {
      active = false;
      if (timer) clearInterval(timer);
      tap?.dispose();
      release?.();
      setSpeech(false);
    };
  }, [listening, stream]);

  return listening && speech;
}
