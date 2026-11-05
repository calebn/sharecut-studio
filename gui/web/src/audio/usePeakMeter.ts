import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeMeterFrame } from "./meterFrameLoop";
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
  latchClip: () => void;
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

type MeterOwner = {
  generation: number;
  read: FrameReader | null;
  clipDb: PeakMeterOptions["clipDb"];
  fallDbPerSec: PeakMeterOptions["fallDbPerSec"];
  floorDb: PeakMeterOptions["floorDb"];
  publishIntervalMs: number;
};
type MeterRun = { owner: MeterOwner; analysis: MeterState };
type MeterView =
  | { kind: "empty"; generation: number }
  | { kind: "published"; owner: MeterOwner; levels: MeterState };

function publishMeter(
  shown: MeterView,
  owner: MeterOwner,
  levels: MeterState,
): MeterView {
  const generation =
    shown.kind === "published" ? shown.owner.generation : shown.generation;
  return generation > owner.generation
    ? shown
    : { kind: "published", owner, levels };
}

/**
 * Drive a `LevelMeter` from any frame source: a shared rAF loop that steps the
 * meter (sample peak → PPM hold → clip latch) via `stepMeter`.
 *
 * The meter resets to silence whenever `read` changes or becomes `null`, so a
 * device switch never carries one mic's hold or clip latch onto the next.
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
  const [view, setView] = useState<MeterView>({ kind: "empty", generation: 0 });
  let levels = SILENT_METER;
  if (view.kind === "published") {
    const owner = view.owner;
    if (
      owner.read === read &&
      Object.is(owner.clipDb, clipDb) &&
      Object.is(owner.fallDbPerSec, fallDbPerSec) &&
      Object.is(owner.floorDb, floorDb) &&
      Object.is(owner.publishIntervalMs, publishIntervalMs)
    ) {
      levels = view.levels;
    } else {
      setView({ kind: "empty", generation: owner.generation });
    }
  }
  const current = useRef<MeterRun | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const owner: MeterOwner = {
      generation: ++generation.current,
      read,
      clipDb,
      fallDbPerSec,
      floorDb,
      publishIntervalMs,
    };
    const run: MeterRun = { owner, analysis: SILENT_METER };
    current.current = run;
    const retire = () => {
      if (current.current === run) current.current = null;
    };
    if (!read) return retire;
    let last: number | null = null;
    let lastPublish = Number.NEGATIVE_INFINITY;
    const unsubscribe = subscribeMeterFrame((now) => {
      if (current.current !== run) return;
      const dt = last === null ? 0 : now - last;
      last = now;
      const prev = run.analysis;
      const next = stepMeter(prev, read(), dt, {
        clipDb,
        fallDbPerSec,
        floorDb,
      });
      run.analysis = next;
      if (
        next.clipped !== prev.clipped ||
        now - lastPublish >= publishIntervalMs
      ) {
        lastPublish = now;
        setView((shown) => publishMeter(shown, owner, next));
      }
    });
    return () => {
      unsubscribe();
      retire();
    };
  }, [read, clipDb, fallDbPerSec, floorDb, publishIntervalMs]);

  const clearClip = useCallback(() => {
    const run = current.current;
    if (!run) return;
    run.analysis = { ...run.analysis, clipped: false };
    setView((shown) => {
      const published =
        shown.kind === "published" && shown.owner === run.owner
          ? shown.levels
          : SILENT_METER;
      return publishMeter(shown, run.owner, { ...published, clipped: false });
    });
  }, []);

  const latchClip = useCallback(() => {
    const run = current.current;
    if (!run || run.analysis.clipped) return;
    run.analysis = { ...run.analysis, clipped: true };
    setView((shown) => {
      const published =
        shown.kind === "published" && shown.owner === run.owner
          ? shown.levels
          : SILENT_METER;
      return publishMeter(shown, run.owner, { ...published, clipped: true });
    });
  }, []);

  return { ...levels, clearClip, latchClip };
}
