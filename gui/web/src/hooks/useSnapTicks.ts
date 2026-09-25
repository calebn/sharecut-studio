import { useCallback, useEffect, useState } from "react";
import { loadWaveformSnap } from "../api";
import { canApplyPass12, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { uniqueTicks } from "../timeline/snapOverlay";
import type { ClipRow } from "../types/project";

const FOCUS_EPS_SEC = 1e-6;
/** Snap ticks come from ±this many seconds around the focus. */
const SNAP_WINDOW_SEC = 1;
/**
 * Ticks are fetched around the focus snapped to this grid, so a moving trim
 * edge or blade hover restarts the debounce only when it crosses a step.
 */
const FETCH_STEP_SEC = SNAP_WINDOW_SEC / 2;
const DEBOUNCE_MS = 80;

/** Ticks with the project, track and source window they were loaded for. */
type SnapState = { key: string; lo: number; hi: number; ticks: number[] };

const NO_TICKS: number[] = [];
const NO_STATE: SnapState = { key: "", lo: 0, hi: -1, ticks: NO_TICKS };

/**
 * Inaudible-cut snap ticks (source seconds) near where an edit would land on
 * this clip: the trim edge while trimming (`trimFocusSourceSec`), else the
 * blade hover inside the clip, else the paused playhead inside it. The
 * selector returns that timeline time or null, so a playing playhead never
 * re-renders the clip. Ticks show only while the focus is inside the window
 * they were loaded for.
 */
export function useSnapTicks(opts: {
  clip: ClipRow;
  /** Track whose media the ticks describe. */
  trackId: string;
  /** Live (preview-aware) source range of the clip. */
  sourceStart: number;
  sourceEnd: number;
  trimFocusSourceSec: number | null;
  enabled: boolean;
}): number[] {
  const { clip, trackId, sourceStart, sourceEnd, trimFocusSourceSec, enabled } =
    opts;
  const tl0 = clip.timeline_start;
  const tl1 = clip.timeline_end;
  const focusTl = useDawStore(
    useCallback(
      (s: {
        bladeHoverSec: number | null;
        isPlaying: boolean;
        playheadSec: number;
      }) => {
        const inClip = (t: number) =>
          t >= tl0 - FOCUS_EPS_SEC && t <= tl1 + FOCUS_EPS_SEC;
        if (s.bladeHoverSec != null && inClip(s.bladeHoverSec)) {
          return s.bladeHoverSec;
        }
        if (!s.isPlaying && inClip(s.playheadSec)) {
          return s.playheadSec;
        }
        return null;
      },
      [tl0, tl1],
    ),
  );
  const projectPath = useDawStore((s) => s.projectPath);
  const guestMode = useDawStore((s) => s.guestMode);
  const shareCapabilities = useDawStore((s) => s.shareCapabilities);
  const canSnap =
    canSuggestStructural(projectPath, guestMode, shareCapabilities) ||
    canApplyPass12(projectPath, guestMode, shareCapabilities) ||
    !guestMode;
  const srcFocus =
    trimFocusSourceSec ??
    (focusTl == null
      ? null
      : sourceStart +
        (focusTl - tl0) *
          ((sourceEnd - sourceStart) / Math.max(1e-9, tl1 - tl0)));
  const [state, setState] = useState<SnapState>(NO_STATE);
  const active = enabled && canSnap && Boolean(projectPath) && srcFocus != null;
  // Fetch around the focus on a coarse grid. The ±1 s window still covers
  // it, and the debounce restarting on every pointer move neither holds off
  // a trim drag nor refetches for a resting blade hover.
  const center =
    srcFocus == null
      ? null
      : Math.round(srcFocus / FETCH_STEP_SEC) * FETCH_STEP_SEC;
  const stateKey = `${projectPath}\n${trackId}`;

  useEffect(() => {
    if (!active || center == null) {
      return;
    }
    const ac = new AbortController();
    const lo = center - SNAP_WINDOW_SEC;
    const hi = center + SNAP_WINDOW_SEC;
    const timer = window.setTimeout(() => {
      loadWaveformSnap(projectPath, trackId, lo, hi, false, ac.signal, center)
        .then((payload) => {
          if (!ac.signal.aborted && payload) {
            setState({
              key: stateKey,
              lo,
              hi,
              ticks: uniqueTicks(payload.ticks),
            });
          }
        })
        .catch(() => {
          // Aborted or offline: a focus outside the loaded window shows none.
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [active, center, projectPath, stateKey, trackId]);

  // Only ticks loaded for this project, track and a window holding the focus:
  // a new focus never shows another window's (or track's) ticks.
  const fresh =
    active &&
    srcFocus != null &&
    state.key === stateKey &&
    srcFocus >= state.lo &&
    srcFocus <= state.hi;
  return fresh ? state.ticks : NO_TICKS;
}
