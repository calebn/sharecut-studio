import { useEffect, useMemo, useRef, useState } from "react";
import { loadWaveformSnap } from "../api";
import {
  PRIORITY_LOUPE,
  PRIORITY_POINTER,
  PRIORITY_VISIBLE,
  requestWaveformTiles,
  subscribeWaveformTiles,
} from "../audio/waveformScheduler";
import type { WaveformKind } from "../audio/waveformSource";
import type { WaveformTile } from "../audio/waveformTiles";
import { snapBinsPerSec } from "../audio/waveformTiles";
import { canApplyPass12, canSuggestStructural } from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  paintWaveform,
  visibleClipWindow,
  WAVEFORM_OVERSCAN_PX,
} from "../timeline/drawWaveform";
import { type QuietBand, quietBandsFromPeaks } from "../timeline/quietWash";
import { uniqueTicks } from "../timeline/snapOverlay";
import type { ClipRow, PeaksData } from "../types/project";
import {
  detailBinsPerSec,
  EDIT_FOCUS_SEC,
  editFocusBinsPerSec,
  OVERVIEW_BINS_PER_SEC,
} from "../utils/timelineZoom.generated";

export type WaveformPaintOverride = {
  sourceStart: number;
  sourceEnd: number;
  cssWidth: number;
};

export function useClipWaveform(opts: {
  clip: ClipRow;
  trackId: string;
  mediaPath: string | null | undefined;
  mediaVersion: string;
  zoomPxPerSec: number;
  sourceStart: number;
  sourceEnd: number;
  peaks: PeaksData | null;
  trimActive: boolean;
  bladeHoverSec: number | null;
  selected: boolean;
}): {
  window: ReturnType<typeof visibleClipWindow>;
  quiet: QuietBand[];
  ticks: number[];
  paint: (
    canvas: HTMLCanvasElement | null,
    override?: WaveformPaintOverride,
  ) => void;
} {
  const {
    clip,
    trackId,
    mediaPath,
    mediaVersion,
    zoomPxPerSec,
    sourceStart,
    sourceEnd,
    peaks,
    trimActive,
    bladeHoverSec,
    selected,
  } = opts;
  const {
    projectPath,
    scrollLeft,
    playheadSec,
    waveformAmpZoom,
    auditionMode,
    guestMode,
    shareCapabilities,
    pointerTrackId,
    measureTimelineViewport,
  } = useDaw();
  const [tiles, setTiles] = useState<WaveformTile[]>([]);
  const [tileRev, setTileRev] = useState(0);
  const [ticks, setTicks] = useState<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const skipClearRef = useRef<number | null>(null);
  const skipRef = useRef(false);
  const latestPaintRef = useRef<{
    canvas: HTMLCanvasElement;
    override?: WaveformPaintOverride;
  } | null>(null);
  const paintOptsRef = useRef({
    peaks,
    tiles,
    sourceStart,
    sourceEnd,
    cssWidth: 0,
    ampZoom: waveformAmpZoom,
    devicePixelRatio: 1,
  });

  useEffect(
    () => subscribeWaveformTiles(trackId, () => setTileRev((n) => n + 1)),
    [trackId],
  );

  const viewportWidth = measureTimelineViewport();
  const win = visibleClipWindow({
    clipTimelineStart: clip.timeline_start,
    clipSourceStart: sourceStart,
    clipSourceEnd: sourceEnd,
    zoomPxPerSec,
    scrollLeft,
    viewportWidth,
    overscanPx: WAVEFORM_OVERSCAN_PX,
  });

  const kind: WaveformKind = auditionMode === "fx" ? "stem" : "raw";
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const needDetail =
    !win.offscreen &&
    detailBinsPerSec(zoomPxPerSec, dpr) > OVERVIEW_BINS_PER_SEC;
  const bins = snapBinsPerSec(detailBinsPerSec(zoomPxPerSec, dpr));

  const focusSec =
    trimActive || bladeHoverSec != null
      ? (bladeHoverSec ?? playheadSec)
      : playheadSec;
  const focusInClip =
    focusSec >= clip.timeline_start - 1e-6 &&
    focusSec <= clip.timeline_end + 1e-6;
  const srcFocus =
    sourceStart +
    (focusSec - clip.timeline_start) *
      ((sourceEnd - sourceStart) /
        Math.max(1e-9, clip.timeline_end - clip.timeline_start));

  useEffect(() => {
    if (!needDetail || !projectPath) {
      setTiles([]);
      return;
    }
    const pri =
      trimActive || bladeHoverSec != null
        ? PRIORITY_LOUPE
        : pointerTrackId === trackId || selected
          ? PRIORITY_POINTER
          : PRIORITY_VISIBLE;
    let next = requestWaveformTiles({
      projectPath,
      trackId,
      kind,
      mediaPath: mediaPath ?? null,
      mediaVersion,
      startSec: win.sourceStart,
      endSec: win.sourceEnd,
      binsPerSec: bins,
      priority: pri,
    });
    if (focusInClip) {
      const loupeBins = snapBinsPerSec(editFocusBinsPerSec(zoomPxPerSec, dpr));
      const extra = requestWaveformTiles({
        projectPath,
        trackId,
        kind,
        mediaPath: mediaPath ?? null,
        mediaVersion,
        startSec: srcFocus - EDIT_FOCUS_SEC / 2,
        endSec: srcFocus + EDIT_FOCUS_SEC / 2,
        binsPerSec: loupeBins,
        priority: PRIORITY_LOUPE,
      });
      next = [...extra, ...next];
    }
    setTiles(next);
  }, [
    bins,
    bladeHoverSec,
    dpr,
    focusInClip,
    kind,
    mediaPath,
    mediaVersion,
    needDetail,
    pointerTrackId,
    projectPath,
    selected,
    srcFocus,
    tileRev,
    trackId,
    trimActive,
    win.sourceEnd,
    win.sourceStart,
    zoomPxPerSec,
  ]);

  const quiet = useMemo(() => {
    if (win.offscreen || !needDetail) {
      return [];
    }
    return quietBandsFromPeaks(
      peaks,
      tiles,
      win.sourceStart,
      win.sourceEnd,
      win.cssWidth,
    );
  }, [
    needDetail,
    peaks,
    tiles,
    win.cssWidth,
    win.offscreen,
    win.sourceEnd,
    win.sourceStart,
  ]);

  const canSnap =
    canSuggestStructural(projectPath, guestMode, shareCapabilities) ||
    canApplyPass12(projectPath, guestMode, shareCapabilities) ||
    !guestMode;

  useEffect(() => {
    if (win.offscreen || !canSnap || !projectPath || !focusInClip) {
      setTicks([]);
      return;
    }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      const lo = srcFocus - 1;
      const hi = srcFocus + 1;
      void loadWaveformSnap(
        projectPath,
        trackId,
        lo,
        hi,
        false,
        ac.signal,
        srcFocus,
      ).then(
        (payload) => {
          if (ac.signal.aborted) {
            return;
          }
          if (payload) {
            setTicks(uniqueTicks(payload.ticks));
          }
        },
        (err: unknown) => {
          if (ac.signal.aborted) {
            return;
          }
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
        },
      );
    }, 80);
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [canSnap, focusInClip, projectPath, srcFocus, trackId, win.offscreen]);

  const ampZoom = waveformAmpZoom;
  paintOptsRef.current = {
    peaks,
    tiles,
    sourceStart: win.sourceStart,
    sourceEnd: win.sourceEnd,
    cssWidth: win.cssWidth,
    ampZoom,
    devicePixelRatio: dpr,
  };

  const flushPaint = () => {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const latest = latestPaintRef.current;
      if (!latest) {
        return;
      }
      const t0 = performance.now();
      const base = paintOptsRef.current;
      const opts = latest.override ? { ...base, ...latest.override } : base;
      const theme = getComputedStyle(document.documentElement);
      const peakFill = theme.getPropertyValue("--color-waveform-peak").trim();
      const peakFillTop = theme
        .getPropertyValue("--color-timeline-waveform-top")
        .trim();
      const peakFillBottom = theme
        .getPropertyValue("--color-timeline-waveform-bottom")
        .trim();
      paintWaveform(latest.canvas, {
        peaks: opts.peaks,
        tiles: opts.tiles,
        sourceStart: opts.sourceStart,
        sourceEnd: opts.sourceEnd,
        cssWidth: opts.cssWidth,
        ampZoom: opts.ampZoom,
        devicePixelRatio: opts.devicePixelRatio,
        peakFill,
        peakFillTop,
        peakFillBottom,
      });
      skipRef.current = performance.now() - t0 > 12;
      if (skipRef.current) {
        skipClearRef.current = requestAnimationFrame(() => {
          skipClearRef.current = null;
          skipRef.current = false;
          flushPaint();
        });
      }
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (skipClearRef.current != null) {
        cancelAnimationFrame(skipClearRef.current);
        skipClearRef.current = null;
      }
    };
  }, []);

  const paint = (
    canvas: HTMLCanvasElement | null,
    override?: WaveformPaintOverride,
  ) => {
    if (!canvas || (win.offscreen && !override)) {
      return;
    }
    latestPaintRef.current = { canvas, override };
    if (skipRef.current) {
      return;
    }
    if (rafRef.current != null) {
      return;
    }
    flushPaint();
  };

  return { window: win, quiet, ticks, paint };
}
