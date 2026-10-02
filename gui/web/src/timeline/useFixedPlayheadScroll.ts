import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  isProgrammaticScroll,
  withProgrammaticScroll,
} from "../presence/followSync";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import {
  centerSecToScrollLeft,
  domToLogicalScrollLeft,
  fixedPlayheadCanvasSize,
  fixedPlayheadLeadPx,
  logicalToDomScrollLeft,
  minLogicalScrollLeft,
  PLAYHEAD_MOVE_MIN_PX,
  SCROLL_SYNC_EPS_PX,
  scrollLeftToCenterSec,
  timelineCanvasSize,
} from "../utils/timelineViewport";
import { noteZoomPointerClientX } from "../utils/zoomPointer";

type Inputs = Readonly<{
  scrollRef: RefObject<HTMLDivElement | null>;
  fixedPlayhead: boolean;
  timeViewportPx: number;
  sessionSec: number;
  zoomPxPerSec: number;
  followingClientId: string | null;
}>;

type WriteScroll = (el: HTMLElement, logical: number, lead: number) => void;

type ScrollBinding = Readonly<{
  scrollRef: RefObject<HTMLDivElement | null>;
  fixedPlayhead: boolean;
  timeViewportPx: number;
  leadPx: number;
  writeScroll: WriteScroll;
}>;

type ScrollResult = Readonly<{
  leadPx: number;
  canvas: Readonly<{ widthPx: number; durationSec: number }>;
  binding: ScrollBinding;
  onScroll: () => void;
  applyZoomAt: (nextZoom: number, clientX: number) => void;
  writeScroll: WriteScroll;
}>;

export function useFixedPlayheadScroll({
  scrollRef,
  fixedPlayhead,
  timeViewportPx,
  sessionSec,
  zoomPxPerSec,
  followingClientId,
}: Inputs): ScrollResult {
  const setScrollLeft = useDawStore((s) => s.setScrollLeft);
  const setPlayheadSec = useDawStore((s) => s.setPlayheadSec);
  const stopFollow = useDawStore((s) => s.stopFollow);
  const applyAnchoredZoom = useDawStore((s) => s.applyAnchoredZoom);
  // Set while a pinch or wheel zoom applies its anchored scroll, so the
  // scroll events it causes neither seek nor unfollow.
  const anchoringZoom = useRef(false);
  // Fixed playhead: pad the time column by the viewport's center offset on
  // each side so every time, 0 and the end included, can sit under the
  // center line. Store scroll stays logical; the DOM scroll is logical + lead.
  const leadPx = fixedPlayhead ? fixedPlayheadLeadPx(timeViewportPx) : 0;
  // Layout effect: zoom anchoring reads the lead in the commit that applies
  // the new margins. A logical scroll before −lead has nowhere to go.
  useLayoutEffect(() => {
    timelineViewportRegistry.setLeadPx(leadPx);
    const { scrollLeft } = useDawStore.getState();
    const floor = minLogicalScrollLeft(leadPx);
    if (scrollLeft < floor) {
      setScrollLeft(floor);
    }
  }, [leadPx, setScrollLeft]);
  // Unmounting drops the pads, so the next (unpadded) view must not inherit a
  // scroll before 0: it would anchor zoom and publish presence from it.
  useEffect(
    () => () => {
      timelineViewportRegistry.setLeadPx(0);
      const { scrollLeft } = useDawStore.getState();
      const floor = minLogicalScrollLeft(0);
      if (scrollLeft < floor) {
        setScrollLeft(floor);
      }
    },
    [setScrollLeft],
  );
  // The last DOM scroll this view wrote. Its scroll event is an echo, not a
  // person's scroll, even if it arrives after the programmatic flags clear.
  const lastWrittenScrollRef = useRef<number | null>(null);
  const writeScroll = useCallback(
    (el: HTMLElement, logical: number, lead: number) => {
      const dom = logicalToDomScrollLeft(logical, lead);
      if (Math.abs(el.scrollLeft - dom) <= SCROLL_SYNC_EPS_PX) {
        return;
      }
      // The flag covers this frame's scroll event; the marker a late one.
      withProgrammaticScroll(() => {
        el.scrollLeft = dom;
      });
      lastWrittenScrollRef.current = el.scrollLeft;
    },
    [],
  );
  // A fixed playhead's canvas is the session (the pads fill the viewport),
  // so the scroll range itself ends with the session end under the line.
  const canvas = fixedPlayhead
    ? fixedPlayheadCanvasSize(sessionSec, zoomPxPerSec)
    : timelineCanvasSize(sessionSec, zoomPxPerSec, timeViewportPx);
  const { durationSec: canvasSec } = canvas;
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const dom = el.scrollLeft;
    const logicalLeft = domToLogicalScrollLeft(dom, leadPx);
    // Only a person's scroll unfollows or seeks. Fit, recentering and follow
    // writes are flagged, and a late echo lands on the last written value.
    // Decide and seek before storing the scroll: a store update can render
    // at once, and the recenter effect must already see the new playhead.
    const echo =
      lastWrittenScrollRef.current !== null &&
      Math.abs(dom - lastWrittenScrollRef.current) <= SCROLL_SYNC_EPS_PX;
    if (!anchoringZoom.current && !isProgrammaticScroll() && !echo) {
      lastWrittenScrollRef.current = null;
      if (followingClientId) {
        stopFollow("local");
      }
      if (fixedPlayhead) {
        const sec = scrollLeftToCenterSec(
          logicalLeft,
          zoomPxPerSec,
          timeViewportPx,
          canvasSec,
        );
        const recordState = useRecordHostStore.getState().snapshot?.state;
        const visualOnlyScroll =
          (recordState === "recording" || recordState === "paused") &&
          logicalLeft >
            centerSecToScrollLeft(canvasSec, zoomPxPerSec, timeViewportPx);
        const playheadSec = useDawStore.getState().playheadSec;
        if (
          !visualOnlyScroll &&
          Math.abs(sec - playheadSec) * zoomPxPerSec > PLAYHEAD_MOVE_MIN_PX
        ) {
          setPlayheadSec(sec);
        }
      }
    }
    setScrollLeft(logicalLeft);
  };

  const applyZoomAt = (nextZoom: number, clientX: number) => {
    anchoringZoom.current = true;
    noteZoomPointerClientX(clientX);
    applyAnchoredZoom(nextZoom, clientX);
    requestAnimationFrame(() => {
      anchoringZoom.current = false;
    });
  };
  const binding = useMemo<ScrollBinding>(
    () => ({ scrollRef, fixedPlayhead, timeViewportPx, leadPx, writeScroll }),
    [scrollRef, fixedPlayhead, timeViewportPx, leadPx, writeScroll],
  );
  return { leadPx, canvas, binding, onScroll, applyZoomAt, writeScroll };
}

/**
 * Writes the store scroll to the DOM in a layout effect. It re-renders with
 * `TimelineView` on a zoom, so the write lands in the commit that widens the
 * content (no clamp to the old width, zoom anchoring kept).
 */
export function TimelineScrollSync({ binding }: { binding: ScrollBinding }) {
  const { scrollRef, leadPx, writeScroll } = binding;
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    writeScroll(el, scrollLeft, leadPx);
  }, [scrollLeft, zoomPxPerSec, leadPx, writeScroll, scrollRef]);
  return null;
}

/**
 * Fixed playhead: transport/seek recenters on the playhead. Pinch and
 * pointer zoom keep the time under the fingers still and move the playhead
 * to the new center; fit and command zoom (menu, keys) anchor at the line
 * (dawStore), so they keep it.
 */
export function FixedPlayheadRecenter({ binding }: { binding: ScrollBinding }) {
  const { scrollRef, leadPx, writeScroll, fixedPlayhead, timeViewportPx } =
    binding;
  const playheadSec = useDawStore((s) => s.playheadSec);
  const playheadSeekRevision = useDawStore((s) => s.playheadSeekRevision);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const userZoomed = useDawStore((s) => s.userZoomed);
  const project = useDawStore((s) => s.project);
  const recordState = useRecordHostStore((s) => s.snapshot?.state);
  const setScrollLeft = useDawStore((s) => s.setScrollLeft);
  const setPlayheadSec = useDawStore((s) => s.setPlayheadSec);
  const prevZoomRef = useRef(zoomPxPerSec);
  const prevPlayheadRef = useRef(playheadSec);
  const prevSeekRevisionRef = useRef(playheadSeekRevision);

  useEffect(() => {
    const el = scrollRef.current;
    // Track every zoom, even while unpadded, so a later switch to a fixed
    // playhead does not read an old zoom as a pinch.
    const zoomChanged = prevZoomRef.current !== zoomPxPerSec;
    prevZoomRef.current = zoomPxPerSec;
    const playheadChanged = prevPlayheadRef.current !== playheadSec;
    prevPlayheadRef.current = playheadSec;
    const seekRevisionChanged =
      prevSeekRevisionRef.current !== playheadSeekRevision;
    prevSeekRevisionRef.current = playheadSeekRevision;
    if (!el || !fixedPlayhead || !project || timeViewportPx <= 0) {
      return;
    }

    const visualOnlyScroll =
      (recordState === "recording" || recordState === "paused") &&
      scrollLeft >
        centerSecToScrollLeft(
          project.timeline_duration_sec,
          zoomPxPerSec,
          timeViewportPx,
        );
    if (visualOnlyScroll && !playheadChanged && !seekRevisionChanged) return;

    if (zoomChanged && userZoomed) {
      const centerSec = scrollLeftToCenterSec(
        scrollLeft,
        zoomPxPerSec,
        timeViewportPx,
        project.timeline_duration_sec,
      );
      if (
        Math.abs(centerSec - playheadSec) * zoomPxPerSec >
        PLAYHEAD_MOVE_MIN_PX
      ) {
        setPlayheadSec(centerSec);
      }
      return;
    }

    const target = centerSecToScrollLeft(
      playheadSec,
      zoomPxPerSec,
      timeViewportPx,
    );
    const current = domToLogicalScrollLeft(el.scrollLeft, leadPx);
    if (Math.abs(current - target) > PLAYHEAD_MOVE_MIN_PX) {
      writeScroll(el, target, leadPx);
      setScrollLeft(target);
    }
  }, [
    playheadSec,
    playheadSeekRevision,
    zoomPxPerSec,
    scrollLeft,
    fixedPlayhead,
    project,
    recordState,
    setScrollLeft,
    setPlayheadSec,
    isPlaying,
    userZoomed,
    leadPx,
    timeViewportPx,
    writeScroll,
    scrollRef,
  ]);
  return null;
}
