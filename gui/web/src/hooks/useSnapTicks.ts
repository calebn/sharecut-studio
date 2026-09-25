import { useCallback, useEffect, useState } from "react";
import { loadWaveformSnap } from "../api";
import { canApplyPass12, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { uniqueTicks } from "../timeline/snapOverlay";
import type { ClipRow } from "../types/project";

const FOCUS_EPS_SEC = 1e-6;
/** Snap ticks come from ±this many seconds around the focus. */
const SNAP_WINDOW_SEC = 1;
const DEBOUNCE_MS = 80;

type SnapState = { ticks: number[] };

const NO_TICKS: number[] = [];

/**
 * Inaudible-cut snap ticks (source seconds) near where an edit would land on
 * this clip: the trim edge while trimming (`trimFocusSourceSec`), else the
 * blade hover inside the clip, else the paused playhead inside it. The
 * selector returns that timeline time or null, so a playing playhead never
 * re-renders the clip.
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
  const [state, setState] = useState<SnapState>({ ticks: NO_TICKS });
  const active = enabled && canSnap && Boolean(projectPath) && srcFocus != null;

  useEffect(() => {
    if (!active || srcFocus == null) {
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      loadWaveformSnap(
        projectPath,
        trackId,
        srcFocus - SNAP_WINDOW_SEC,
        srcFocus + SNAP_WINDOW_SEC,
        false,
        ac.signal,
        srcFocus,
      )
        .then((payload) => {
          if (!ac.signal.aborted && payload) {
            setState({ ticks: uniqueTicks(payload.ticks) });
          }
        })
        .catch(() => {
          // Aborted or offline: keep the last ticks.
        });
    }, DEBOUNCE_MS);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [active, projectPath, srcFocus, trackId]);

  return active ? state.ticks : NO_TICKS;
}
