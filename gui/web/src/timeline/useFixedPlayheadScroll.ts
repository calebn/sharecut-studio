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
import { useRecordHostStore } from "../record";
import { useDawStore } from "../state/dawStore";
import {
  timelineViewportRegistry,
  type VisualPan,
} from "../state/timelineViewportRegistry";
import {
  domToLogicalScrollLeft,
  fixedLineOffsetPx,
  fixedPlayheadCanvasSize,
  fixedPlayheadEndLeadPx,
  fixedPlayheadLeadPx,
  followScrollLeft,
  logicalToDomScrollLeft,
  measureTimelineColumns,
  minLogicalScrollLeft,
  PLAYHEAD_MOVE_MIN_PX,
  SCROLL_SYNC_EPS_PX,
  scrollLeftToLineSec,
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

type PanGeometry = VisualPan["geometry"];

type RecordState = NonNullable<
  ReturnType<typeof useRecordHostStore.getState>["snapshot"]
>["state"];

function isRecordingVisualPan(
  recordState: RecordState | undefined,
  geometry: PanGeometry,
  savedSessionSec: number,
): boolean {
  return (
    (recordState === "recording" || recordState === "paused") &&
    geometry.scrollLeft + geometry.lineOffsetPx >
      savedSessionSec * geometry.zoomPxPerSec
  );
}

type WriteScroll = (el: HTMLElement, logical: number, lead: number) => void;

type ScrollBinding = Readonly<{
  scrollRef: RefObject<HTMLDivElement | null>;
  fixedPlayhead: boolean;
  timeViewportPx: number;
  leadPx: number;
  writeScroll: WriteScroll;
  /** The seek revision a person's own scroll made; it must not recenter. */
  scrubRevisionRef: RefObject<number>;
  /** The playhead time a person's own scroll set; the follow leaves it be. */
  scrubSecRef: RefObject<number | null>;
}>;

function requestedScrollLeft(state: ReturnType<typeof useDawStore.getState>) {
  const projection = timelineViewportRegistry.getLayoutProjection();
  if (
    projection &&
    projection.projectPath === state.projectPath &&
    projection.playheadSec === state.playheadSec &&
    projection.seekRevision === state.playheadSeekRevision &&
    projection.zoomPxPerSec === state.zoomPxPerSec &&
    projection.appliedLeft === state.scrollLeft
  ) {
    return projection.requestedLeft;
  }
  timelineViewportRegistry.setLayoutProjection(null);
  return state.scrollLeft;
}

type ScrollResult = Readonly<{
  leadPx: number;
  endLeadPx: number;
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
  // A scrub seeks the audio like any seek, but the view is already where the
  // person put it, so the recenter skips this revision.
  const scrubRevisionRef = useRef(-1);
  const scrubSecRef = useRef<number | null>(null);
  // Set while a pinch or wheel zoom applies its anchored scroll, so the
  // scroll events it causes neither seek nor unfollow.
  const anchoringZoom = useRef(false);
  // Fixed playhead: pad the time column (half a viewport before time 0, a
  // whole one after the end) so every time can be scrubbed to the playhead
  // wherever it sits. The timeline loads at logical scroll 0, time 0 beside
  // the headers. Store scroll stays logical; the DOM scroll is logical + lead.
  const leadPx = fixedPlayhead ? fixedPlayheadLeadPx(timeViewportPx) : 0;
  const endLeadPx = fixedPlayhead ? fixedPlayheadEndLeadPx(timeViewportPx) : 0;
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
        lastWrittenScrollRef.current = el.scrollLeft;
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
    const columns = measureTimelineColumns(el);
    if (
      Math.abs(columns.timeViewportPx - timeViewportPx) > SCROLL_SYNC_EPS_PX
    ) {
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
      timelineViewportRegistry.setLayoutProjection(null);
      timelineViewportRegistry.setVisualPan(null);
      if (followingClientId) {
        stopFollow("local");
      }
      if (fixedPlayhead) {
        // A scroll moves the time by exactly what it moved the content: the
        // playhead stays where it sits in the view.
        const {
          playheadSec,
          scrollLeft: storedLeft,
          playheadSeekRevision,
          projectPath,
          project,
        } = useDawStore.getState();
        const lineX = fixedLineOffsetPx(
          playheadSec,
          zoomPxPerSec,
          storedLeft,
          timeViewportPx,
        );
        const recordState = useRecordHostStore.getState().snapshot?.state;
        const geometry = {
          scrollLeft: logicalLeft,
          lineOffsetPx: lineX,
          zoomPxPerSec,
        };
        const visualOnlyScroll = isRecordingVisualPan(
          recordState,
          geometry,
          project?.timeline_duration_sec ?? sessionSec,
        );
        timelineViewportRegistry.setVisualPan(
          visualOnlyScroll
            ? {
                geometry,
                scrollLeft: logicalLeft,
                zoomPxPerSec,
                playheadSec,
                seekRevision: playheadSeekRevision,
                projectPath,
              }
            : null,
        );
        const sec = scrollLeftToLineSec(
          logicalLeft,
          lineX,
          zoomPxPerSec,
          canvasSec,
        );
        if (!visualOnlyScroll && sec !== playheadSec) {
          setPlayheadSec(sec);
          scrubRevisionRef.current =
            useDawStore.getState().playheadSeekRevision;
          scrubSecRef.current = sec;
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
    () => ({
      scrollRef,
      fixedPlayhead,
      timeViewportPx,
      leadPx,
      writeScroll,
      scrubRevisionRef,
      scrubSecRef,
    }),
    [scrollRef, fixedPlayhead, timeViewportPx, leadPx, writeScroll],
  );
  return {
    leadPx,
    endLeadPx,
    canvas,
    binding,
    onScroll,
    applyZoomAt,
    writeScroll,
  };
}

/**
 * Writes the store scroll to the DOM in a layout effect. It re-renders with
 * `TimelineView` on a zoom, so the write lands in the commit that widens the
 * content (no clamp to the old width, zoom anchoring kept).
 */
export function TimelineScrollSync({ binding }: { binding: ScrollBinding }) {
  const { scrollRef, leadPx, timeViewportPx, writeScroll } = binding;
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const geometryRef = useRef<{
    leadPx: number;
    timeViewportPx: number;
    zoomPxPerSec: number;
  } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const previous = geometryRef.current;
    const geometryChanged =
      !previous ||
      previous.leadPx !== leadPx ||
      previous.timeViewportPx !== timeViewportPx ||
      previous.zoomPxPerSec !== zoomPxPerSec;
    geometryRef.current = { leadPx, timeViewportPx, zoomPxPerSec };
    const state = useDawStore.getState();
    const requestedLeft = requestedScrollLeft(state);
    if (
      geometryChanged ||
      Math.abs(
        el.scrollLeft - logicalToDomScrollLeft(state.scrollLeft, leadPx),
      ) > SCROLL_SYNC_EPS_PX
    ) {
      writeScroll(el, requestedLeft, leadPx);
    }
    const appliedLeft = domToLogicalScrollLeft(el.scrollLeft, leadPx);
    timelineViewportRegistry.setLayoutProjection(
      appliedLeft !== requestedLeft
        ? {
            projectPath: state.projectPath,
            playheadSec: state.playheadSec,
            seekRevision: state.playheadSeekRevision,
            zoomPxPerSec: state.zoomPxPerSec,
            requestedLeft,
            appliedLeft,
          }
        : null,
    );
    if (appliedLeft !== state.scrollLeft) state.setScrollLeft(appliedLeft);
  }, [
    scrollLeft,
    zoomPxPerSec,
    leadPx,
    timeViewportPx,
    writeScroll,
    scrollRef,
  ]);
  return null;
}

/**
 * Fixed playhead: the playhead sits where it is in the view (time 0 beside
 * the headers on load) and the view follows it only once it passes the
 * center, so playback holds it there. A seek recenters at once, but never
 * past time 0. A scrub keeps the playhead where it sits (the scroll handler
 * moves the time). Pinch and pointer zoom keep the time under the fingers
 * still and move the playhead to the new time at its place; fit and command
 * zoom (menu, keys) keep the playhead's time and place (dawStore).
 */
export function FixedPlayheadRecenter({ binding }: { binding: ScrollBinding }) {
  const {
    scrollRef,
    leadPx,
    writeScroll,
    fixedPlayhead,
    timeViewportPx,
    scrubRevisionRef,
    scrubSecRef,
  } = binding;
  const playheadSec = useDawStore((s) => s.playheadSec);
  const playheadSeekRevision = useDawStore((s) => s.playheadSeekRevision);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const userZoomed = useDawStore((s) => s.userZoomed);
  const project = useDawStore((s) => s.project);
  const projectPath = useDawStore((s) => s.projectPath);
  const recordState = useRecordHostStore((s) => s.snapshot?.state);
  const setScrollLeft = useDawStore((s) => s.setScrollLeft);
  const setPlayheadSec = useDawStore((s) => s.setPlayheadSec);
  const readyRef = useRef(false);
  const prevRef = useRef({
    zoom: zoomPxPerSec,
    playhead: playheadSec,
    scroll: scrollLeft,
    requestedScroll: scrollLeft,
    visualPan: false,
    seekRevision: playheadSeekRevision,
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const current = useDawStore.getState();
    const {
      playheadSec,
      playheadSeekRevision,
      zoomPxPerSec,
      scrollLeft,
      userZoomed,
      project,
      projectPath,
    } = current;
    const recordState = useRecordHostStore.getState().snapshot?.state;
    const pan = timelineViewportRegistry.getVisualPan();
    const requestedLeft = requestedScrollLeft(current);
    // Track every change, even while unpadded, so a later switch to a fixed
    // playhead does not read an old zoom as a pinch.
    const prev = prevRef.current;
    prevRef.current = {
      zoom: zoomPxPerSec,
      playhead: playheadSec,
      scroll: scrollLeft,
      requestedScroll: requestedLeft,
      visualPan: false,
      seekRevision: playheadSeekRevision,
    };
    const zoomChanged = prev.zoom !== zoomPxPerSec;
    const playheadChanged = prev.playhead !== playheadSec;
    const seekRevisionChanged =
      prev.seekRevision !== playheadSeekRevision &&
      playheadSeekRevision !== scrubRevisionRef.current;
    if (!project) {
      timelineViewportRegistry.setVisualPan(null);
      return;
    }
    if (!el || timeViewportPx <= 0) return;
    const sessionSec = project.timeline_duration_sec;
    // The first look at a mounted timeline (a tab switch, a loaded project)
    // follows a playhead that moved while it was away.
    const firstLook = !readyRef.current;
    readyRef.current = true;

    const retainsOriginalPanGeometry =
      pan !== null &&
      pan.playheadSec === current.playheadSec &&
      pan.seekRevision === current.playheadSeekRevision &&
      pan.projectPath === current.projectPath &&
      ((pan.scrollLeft === requestedLeft &&
        pan.zoomPxPerSec === current.zoomPxPerSec) ||
        (zoomChanged &&
          userZoomed &&
          pan.scrollLeft === prev.requestedScroll &&
          pan.zoomPxPerSec === prev.zoom));
    const geometry = retainsOriginalPanGeometry
      ? pan.geometry
      : {
          scrollLeft: requestedLeft,
          lineOffsetPx: fixedLineOffsetPx(
            playheadSec,
            zoomPxPerSec,
            requestedLeft,
            timeViewportPx,
          ),
          zoomPxPerSec,
        };
    const visualOnlyScroll = isRecordingVisualPan(
      recordState,
      geometry,
      sessionSec,
    );
    prevRef.current.visualPan = visualOnlyScroll;
    timelineViewportRegistry.setVisualPan(
      visualOnlyScroll
        ? {
            geometry,
            scrollLeft: requestedLeft,
            zoomPxPerSec,
            playheadSec,
            seekRevision: playheadSeekRevision,
            projectPath,
          }
        : null,
    );
    if (!fixedPlayhead) return;
    if (visualOnlyScroll && !playheadChanged && !seekRevisionChanged) return;
    const previewEnded =
      prev.visualPan && recordState !== "recording" && recordState !== "paused";
    const panEnded = (pan !== null || previewEnded) && !visualOnlyScroll;

    if (zoomChanged && userZoomed) {
      const lineX = fixedLineOffsetPx(
        prev.playhead,
        prev.zoom,
        prev.scroll,
        timeViewportPx,
      );
      const lineSec = scrollLeftToLineSec(
        scrollLeft,
        lineX,
        zoomPxPerSec,
        sessionSec,
      );
      if (
        Math.abs(lineSec - playheadSec) * zoomPxPerSec >
        PLAYHEAD_MOVE_MIN_PX
      ) {
        setPlayheadSec(lineSec);
        scrubRevisionRef.current = useDawStore.getState().playheadSeekRevision;
        scrubSecRef.current = lineSec;
      }
      return;
    }

    if (!seekRevisionChanged && !playheadChanged && !firstLook && !panEnded)
      return;
    // A scrub put the playhead here with the view where the person left it.
    if (
      !seekRevisionChanged &&
      !firstLook &&
      !panEnded &&
      playheadSec === scrubSecRef.current
    )
      return;
    // A session that fits the view has nothing to scroll to but its start.
    if (sessionSec * zoomPxPerSec <= timeViewportPx) {
      if (seekRevisionChanged && scrollLeft !== 0) {
        writeScroll(el, 0, leadPx);
        setScrollLeft(0);
      }
      return;
    }
    const rawLineX = playheadSec * zoomPxPerSec - scrollLeft;
    // A scrub keeps the playhead at an edge exactly, up to float noise.
    const edge = PLAYHEAD_MOVE_MIN_PX;
    const pastCenter = rawLineX > timeViewportPx / 2 + edge;
    const offView = rawLineX < -edge || rawLineX > timeViewportPx + edge;
    if (!seekRevisionChanged && !pastCenter && !offView) return;
    const target = followScrollLeft(playheadSec, zoomPxPerSec, timeViewportPx);
    const currentLeft = domToLogicalScrollLeft(el.scrollLeft, leadPx);
    if (Math.abs(currentLeft - target) > PLAYHEAD_MOVE_MIN_PX) {
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
    projectPath,
    recordState,
    setScrollLeft,
    setPlayheadSec,
    userZoomed,
    leadPx,
    timeViewportPx,
    writeScroll,
    scrollRef,
    scrubRevisionRef,
    scrubSecRef,
  ]);
  return null;
}
