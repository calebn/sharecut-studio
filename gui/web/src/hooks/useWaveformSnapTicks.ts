import { useCallback, useEffect, useMemo, useState } from "react";
import { loadWaveformSnap } from "../api";
import { uniqueTicks } from "../timeline/snapOverlay";

const SNAP_WINDOW_SEC = 1;
const FETCH_STEP_SEC = SNAP_WINDOW_SEC / 2;
const DEBOUNCE_MS = 80;

type SnapState = { key: string; lo: number; hi: number; ticks: number[] };

const NO_TICKS: number[] = [];
const NO_STATE: SnapState = { key: "", lo: 0, hi: -1, ticks: NO_TICKS };

export type WaveformSnapTickResource = {
  ticks: number[];
  resolveTicks: (focusSec: number, signal: AbortSignal) => Promise<number[]>;
};

async function fetchTicks(
  projectPath: string,
  trackId: string,
  focusSec: number,
  signal: AbortSignal,
): Promise<{ center: number; lo: number; hi: number; ticks: number[] }> {
  const center = Math.round(focusSec / FETCH_STEP_SEC) * FETCH_STEP_SEC;
  const lo = center - SNAP_WINDOW_SEC;
  const hi = center + SNAP_WINDOW_SEC;
  const payload = await loadWaveformSnap(
    projectPath,
    trackId,
    lo,
    hi,
    false,
    signal,
    center,
  );
  if (signal.aborted) {
    throw new DOMException("Snap request cancelled", "AbortError");
  }
  if (!payload) {
    throw new Error("Nearby waveform snap points could not be loaded.");
  }
  return { center, lo, hi, ticks: uniqueTicks(payload.ticks) };
}

/** Load bounded source-clock snap ticks around a live source-time focus. */
export function useWaveformSnapTicks(
  projectPath: string,
  trackId: string,
  sourceFocusSec: number | null,
  enabled: boolean,
): WaveformSnapTickResource {
  const [state, setState] = useState<SnapState>(NO_STATE);
  const active = enabled && Boolean(projectPath) && sourceFocusSec != null;
  const center =
    sourceFocusSec == null
      ? null
      : Math.round(sourceFocusSec / FETCH_STEP_SEC) * FETCH_STEP_SEC;
  const stateKey = `${projectPath}\n${trackId}`;

  useEffect(() => {
    if (!active || center == null) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchTicks(projectPath, trackId, center, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setState({
              key: stateKey,
              lo: result.lo,
              hi: result.hi,
              ticks: result.ticks,
            });
          }
        })
        .catch(() => {
          // Aborted or offline: the current focus has no usable ticks.
        });
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, center, projectPath, stateKey, trackId]);

  const ticks =
    active &&
    sourceFocusSec != null &&
    state.key === stateKey &&
    sourceFocusSec >= state.lo &&
    sourceFocusSec <= state.hi
      ? state.ticks
      : NO_TICKS;
  const resolveTicks = useCallback(
    async (focusSec: number, signal: AbortSignal) => {
      const result = await fetchTicks(projectPath, trackId, focusSec, signal);
      setState({
        key: stateKey,
        lo: result.lo,
        hi: result.hi,
        ticks: result.ticks,
      });
      return result.ticks;
    },
    [projectPath, stateKey, trackId],
  );
  return useMemo(() => ({ ticks, resolveTicks }), [resolveTicks, ticks]);
}
