import { useCallback } from "react";
import { canApplyPass12, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { useWaveformSnapTicks } from "./useWaveformSnapTicks";

const FOCUS_EPS_SEC = 1e-6;

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
  return useWaveformSnapTicks(
    projectPath,
    trackId,
    srcFocus,
    enabled && canSnap,
  ).ticks;
}
