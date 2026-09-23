import { useCallback, useEffect, useRef, useState } from "react";
import {
  type MeterState,
  SILENT_METER,
  type StepMeterOptions,
  stepMeter,
} from "./metering";

/** Returns the latest time-domain frame (float samples, −1..1). */
export type FrameReader = () => ArrayLike<number>;

export type PeakMeterLevels = MeterState & {
  clearClip: () => void;
};

export type PeakMeterOptions = StepMeterOptions & {
  /**
   * Minimum ms between React state commits. Analysis runs every animation
   * frame; the owner re-renders at most ~30 Hz. A clip latch always commits
   * immediately.
   */
  publishIntervalMs?: number;
};

export const METER_PUBLISH_INTERVAL_MS = 33;

/**
 * Drive a `LevelMeter` from any frame source: one rAF loop that steps the
 * meter (sample peak → PPM hold → clip latch) via `stepMeter`.
 *
 * The meter resets to silence whenever `read` changes or becomes `null`, so a
 * device switch never carries one mic's hold or clip latch onto the next.
 * `useInputPeakDb` adapts a mic stream to this; stories feed it synthesized
 * frames so they exercise the same loop.
 */
export function usePeakMeter(
  read: FrameReader | null,
  {
    clipDb,
    fallDbPerSec,
    floorDb,
    publishIntervalMs = METER_PUBLISH_INTERVAL_MS,
  }: PeakMeterOptions = {},
): PeakMeterLevels {
  const [levels, setLevels] = useState<MeterState>(SILENT_METER);
  const stateRef = useRef<MeterState>(SILENT_METER);

  useEffect(() => {
    stateRef.current = SILENT_METER;
    setLevels(SILENT_METER);
    if (!read) return;

    let raf = 0;
    let last: number | null = null;
    let lastPublish = Number.NEGATIVE_INFINITY;
    const tick = (now: number) => {
      const dt = last === null ? 0 : now - last;
      last = now;
      const prev = stateRef.current;
      const next = stepMeter(prev, read(), dt, {
        clipDb,
        fallDbPerSec,
        floorDb,
      });
      stateRef.current = next;
      if (
        next.clipped !== prev.clipped ||
        now - lastPublish >= publishIntervalMs
      ) {
        lastPublish = now;
        setLevels(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [read, clipDb, fallDbPerSec, floorDb, publishIntervalMs]);

  const clearClip = useCallback(() => {
    stateRef.current = { ...stateRef.current, clipped: false };
    setLevels((s) => ({ ...s, clipped: false }));
  }, []);

  return { ...levels, clearClip };
}
