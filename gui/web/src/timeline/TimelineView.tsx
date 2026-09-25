import {
  type CSSProperties,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { shallow } from "zustand/shallow";
import { execute } from "../commands/execute";
import {
  allClipsFromTracks,
  type ClipMoveItem,
  type ClipMovePointerInfo,
  type ClipSelectMods,
  computeClipMoves,
  laneMovePreview,
  moveSnapTicks,
  movesDifferFromClips,
  snapMoveDeltaSec,
  trackIdFromPoint,
} from "../edit/clipMove";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { presenceColorVar } from "../presence/colors";
import {
  isProgrammaticScroll,
  withProgrammaticScroll,
} from "../presence/followSync";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { EMPTY_ARR, EMPTY_CLIPS } from "../utils/empty";
import {
  COMPACT_LANE_HEIGHT,
  FIT_GUTTER,
  LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  RULER_HEIGHT,
} from "../utils/layout";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import {
  domToLogicalScrollLeft,
  fixedPlayheadCanvasSize,
  fixedPlayheadLeadPx,
  fixedPlayheadLinePx,
  logicalToDomScrollLeft,
  measureTimelineColumns,
  minLogicalScrollLeft,
  PLAYHEAD_MOVE_MIN_PX,
  SCROLL_SYNC_EPS_PX,
  scrollLeftToCenterSec,
  timelineCanvasSize,
  timelineHeaderEl,
} from "../utils/timelineViewport";
import { useStableCallback } from "../utils/useStableCallback";
import { noteZoomPointerClientX } from "../utils/zoomPointer";
import { AuditionOverlay } from "./AuditionOverlay";
import { CommentPlaybackBubble } from "./CommentPlaybackBubble";
import { CommentSelectionOverlay } from "./CommentSelectionOverlay";
import { selectFollowColorIndex } from "./followTarget";
import { MarkerLane } from "./MarkerLane";
import { Playhead } from "./Playhead";
import { PresenceOverlay } from "./PresenceOverlay";
import {
  BladeGuide,
  FixedPlayheadRecenter,
  FollowPlayheadChip,
  TimelineScrollSync,
} from "./TimelineLeaves";
import { TimeRuler } from "./TimeRuler";
import { TrackLane } from "./TrackLane";
import {
  fitLaneHeight,
  markerLaneHeight,
  markerRows,
  TimelineGestureProvider,
  TimelineMetricsProvider,
  useGestureStable,
  useTimelineMetrics,
} from "./timelineMetrics";
import { attachTimelineZoomGestures } from "./timelineZoomGestures";

type Props = {
  /** Phone Timeline mode: playhead fixed at viewport center; scrub by scrolling. */
  fixedPlayhead?: boolean;
  /** Desktop/tablet track headers locked into the same scroller as the lanes. */
  headerSlot?: ReactNode;
};

export function TimelineViewView({ fixedPlayhead = false, headerSlot }: Props) {
  // Before a project loads this view provides no metrics, so its skeleton and
  // any header column beside or inside it read the same ambient defaults.
  const loadingMetrics = useTimelineMetrics();
  const {
    projectPath,
    zoomPxPerSec,
    setScrollLeft,
    registerTimelineLead,
    setPlayheadSec,
    selection,
    setSelection,
    userZoomed,
    applyAnchoredZoom,
    setTimelineFocused,
    layers,
    fitToWindow,
    registerTimelineViewport,
    registerLanesEl,
    sessionRegion,
    lastAgentQuery,
    commentMode,
    setCommentDraft,
    setActiveTab,
    isPlaying,
    toolMode,
    selectedTrackIds,
    selectedClipIds,
    selectClip,
    guestMode,
    shareCapabilities,
    highlightStaleRender,
    followingClientId,
    stopFollow,
    setBladeHoverSec,
    setTimelineViewportWidth,
  } = useDawStore(
    useShallow((s) => ({
      projectPath: s.projectPath,
      zoomPxPerSec: s.zoomPxPerSec,
      setScrollLeft: s.setScrollLeft,
      registerTimelineLead: s.registerTimelineLead,
      setPlayheadSec: s.setPlayheadSec,
      selection: s.selection,
      setSelection: s.setSelection,
      userZoomed: s.userZoomed,
      applyAnchoredZoom: s.applyAnchoredZoom,
      setTimelineFocused: s.setTimelineFocused,
      layers: s.layers,
      fitToWindow: s.fitToWindow,
      registerTimelineViewport: s.registerTimelineViewport,
      registerLanesEl: s.registerLanesEl,
      sessionRegion: s.sessionRegion,
      lastAgentQuery: s.lastAgentQuery,
      commentMode: s.commentMode,
      setCommentDraft: s.setCommentDraft,
      setActiveTab: s.setActiveTab,
      isPlaying: s.isPlaying,
      toolMode: s.toolMode,
      selectedTrackIds: s.selectedTrackIds,
      selectedClipIds: s.selectedClipIds,
      selectClip: s.selectClip,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      highlightStaleRender: s.highlightStaleRender,
      followingClientId: s.followingClientId,
      stopFollow: s.stopFollow,
      setBladeHoverSec: s.setBladeHoverSec,
      setTimelineViewportWidth: s.setTimelineViewportWidth,
    })),
  );
  const followColorIndex = useDawStore(selectFollowColorIndex);
  const project = useDawStore(
    useShallow((s) => {
      const p = s.project;
      if (!p) {
        return null;
      }
      return {
        tracks: p.tracks,
        clips: p.clips,
        timeline_duration_sec: p.timeline_duration_sec,
        comments: p.comments,
        envelopes: p.envelopes,
        applied_edits: p.applied_edits,
        pending_edits: p.pending_edits,
        peaks_index: p.peaks_index,
        chapters: p.chapters,
        social_clips: p.social_clips,
        render_status: p.render_status,
      };
    }),
  );
  const staleBreakdown = useStaleRenderBreakdown(
    project as import("../types/project").ProjectView | null,
  );
  const showStaleInv = highlightStaleRender;
  // Fallback whole-lane edge when stem stale but no journal (or whole-track cause).
  const fallbackWhole = new Set(
    staleBreakdown.invalidations.length === 0
      ? staleBreakdown.staleTrackIds
      : staleBreakdown.wholeTrackIds,
  );
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  // Set while a pinch or wheel zoom applies its anchored scroll, so the
  // scroll events it causes neither seek nor unfollow.
  const anchoringZoom = useRef(false);
  const applyZoomAtRef = useRef<(nextZoom: number, clientX: number) => void>(
    () => undefined,
  );
  // One measurement of the scroller drives the fit, the lead pads, the fixed
  // line, the center math and the stage edges, so they cannot disagree.
  const [columns, setColumns] = useState({
    headerOffsetPx: 0,
    timeViewportPx: 0,
  });
  const { timeViewportPx, headerOffsetPx } = columns;
  // Fixed playhead: pad the time column by the viewport's center offset on
  // each side so every time, 0 and the end included, can sit under the
  // center line. Store scroll stays logical; the DOM scroll is logical + lead.
  const leadPx = fixedPlayhead ? fixedPlayheadLeadPx(timeViewportPx) : 0;
  // Layout effect: zoom anchoring reads the lead in the commit that applies
  // the new margins. A logical scroll before −lead has nowhere to go.
  useLayoutEffect(() => {
    registerTimelineLead(leadPx);
    const { scrollLeft } = useDawStore.getState();
    const floor = minLogicalScrollLeft(leadPx);
    if (scrollLeft < floor) {
      setScrollLeft(floor);
    }
  }, [leadPx, registerTimelineLead, setScrollLeft]);
  // Unmounting drops the pads, so the next (unpadded) view must not inherit a
  // scroll before 0: it would anchor zoom and publish presence from it.
  useEffect(
    () => () => {
      registerTimelineLead(0);
      const { scrollLeft } = useDawStore.getState();
      const floor = minLogicalScrollLeft(0);
      if (scrollLeft < floor) {
        setScrollLeft(floor);
      }
    },
    [registerTimelineLead, setScrollLeft],
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
  const [movePlacements, setMovePlacements] = useState<ClipMoveItem[] | null>(
    null,
  );
  const canMoveClips =
    toolMode === "select" &&
    !commentMode &&
    canApplyPass12(projectPath, guestMode, shareCapabilities);
  const allClips = project ? allClipsFromTracks(project.clips.tracks) : [];
  const trackIds = project?.tracks.map((t) => t.id) ?? [];
  const moveGestureRef = useRef<{
    movingIds: string[];
    clips: ClipRow[];
    trackIds: string[];
    /** Lane the last preview showed; the drop commits there. */
    destTrackId?: string;
  } | null>(null);

  const resolveMove = (
    anchorId: string,
    info: ClipMovePointerInfo,
    phase: "preview" | "commit",
  ): ClipMoveItem[] => {
    if (!moveGestureRef.current) {
      const selectedNow = useDawStore.getState().selectedClipIds;
      moveGestureRef.current = {
        movingIds: selectedNow.includes(anchorId) ? selectedNow : [anchorId],
        clips: allClips,
        trackIds,
      };
    }
    const snap = moveGestureRef.current;
    const anchor = snap.clips.find((c) => c.id === anchorId);
    if (!anchor) {
      return [];
    }
    // Commit to the ghost's lane, not a fresh hit-test: an update landing
    // under a still pointer must not change where the clip drops.
    const destTrackId =
      (phase === "commit" ? snap.destTrackId : undefined) ??
      trackIdFromPoint(info.clientX, info.clientY) ??
      anchor.track_id;
    snap.destTrackId = destTrackId;
    const ticks = moveSnapTicks({
      clips: snap.clips,
      movingIds: new Set(snap.movingIds),
      playheadSec: useDawStore.getState().playheadSec,
      extraTicks: info.extraTicks,
    });
    const deltaSec = snapMoveDeltaSec({
      anchorStart: anchor.timeline_start,
      anchorEnd: anchor.timeline_end,
      deltaSec: info.deltaSec,
      ticks,
      zoomPxPerSec,
    });
    return computeClipMoves({
      clips: snap.clips,
      trackIds: snap.trackIds,
      movingIds: snap.movingIds,
      anchorId,
      destTrackId,
      deltaSec,
    });
  };

  const endMoveGesture = () => {
    moveGestureRef.current = null;
    setMovePlacements(null);
  };

  useEffect(() => {
    registerTimelineViewport(scrollRef.current);
    registerLanesEl(lanesRef.current);
    return () => {
      registerTimelineViewport(null);
      registerLanesEl(null);
    };
  }, [registerTimelineViewport, registerLanesEl, project]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    return attachTimelineZoomGestures(
      el,
      {
        getZoom: () => useDawStore.getState().zoomPxPerSec,
        applyZoomAt: (nextZoom, clientX) => {
          applyZoomAtRef.current(nextZoom, clientX);
        },
        onZoomClaimed: () => setTimelineFocused(true),
      },
      // The whole scroller claims zoom, fixed-playhead lead pads included,
      // except the track headers (mute/solo, reorder).
      { exclude: () => timelineHeaderEl(el) },
    );
  }, [project, setTimelineFocused]);

  // Fit-to-window lanes: few tracks grow to fill the stage. The stage height
  // lives in a ref; state changes only when the whole-px lane height does, so
  // a vertical resize (e.g. the tabs splitter) does not re-render every clip.
  const chapters = project?.chapters ?? EMPTY_ARR;
  const socialClips = project?.social_clips ?? EMPTY_ARR;
  const comments = project?.comments ?? EMPTY_ARR;
  const liveRows = useMemo(
    () =>
      markerRows({
        chapters,
        socialClips,
        comments,
        showMarkers: layers.showMarkers,
        showComments: layers.showComments,
      }),
    [chapters, socialClips, comments, layers.showMarkers, layers.showComments],
  );
  const liveMarkerLaneHeightPx = markerLaneHeight(liveRows);
  const trackCount = project?.tracks.length ?? 0;
  const [fittedLaneHeight, setFittedLaneHeight] = useState(LANE_HEIGHT);
  const fittedLaneHeightRef = useRef(LANE_HEIGHT);
  const stageHeightRef = useRef(0);
  const fitInputsRef = useRef({
    trackCount,
    markerLaneHeightPx: liveMarkerLaneHeightPx,
  });
  const refitLanes = useCallback(() => {
    const inputs = fitInputsRef.current;
    const next = fitLaneHeight(
      stageHeightRef.current -
        RULER_HEIGHT -
        inputs.markerLaneHeightPx -
        FIT_GUTTER,
      inputs.trackCount,
    );
    if (next !== fittedLaneHeightRef.current) {
      fittedLaneHeightRef.current = next;
      setFittedLaneHeight(next);
    }
  }, []);

  // Tracks or marker rows changed without a resize: re-fit from the last
  // measured stage. Declared before the observer so its inputs are current.
  useLayoutEffect(() => {
    fitInputsRef.current = {
      trackCount,
      markerLaneHeightPx: liveMarkerLaneHeightPx,
    };
    refitLanes();
  }, [trackCount, liveMarkerLaneHeightPx, refitLanes]);

  // Lane geometry as drawn: held still while a move / trim / fade / envelope
  // drag is active (children hold via useHoldTimelineMetrics).
  const liveLayout = useMemo(
    () => ({
      laneHeight: fittedLaneHeight,
      markerLaneHeightPx: liveMarkerLaneHeightPx,
      rows: liveRows,
    }),
    [fittedLaneHeight, liveMarkerLaneHeightPx, liveRows],
  );
  const { value: layout, hold: holdLayout } = useGestureStable(liveLayout);
  const { laneHeight, markerLaneHeightPx, rows } = layout;
  const moving = movePlacements != null;
  useEffect(() => (moving ? holdLayout() : undefined), [moving, holdLayout]);

  // The last fit (time viewport, session length). An effect re-run for any
  // other project change (comments, render status…) must not refit, which
  // would abort waveform work and rewrite a fixed playhead's scroll.
  const fittedRef = useRef<{ widthPx: number; sessionSec: number } | null>(
    null,
  );
  // One observer on the scroller and its header column, used only as a
  // trigger: every measurement reads the element (clientWidth), the same
  // source as fit commands, zoom anchoring and presence. The time viewport
  // drives the fit, the lead pads and the fixed line; the height the lanes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !project) {
      return;
    }
    const sessionSec = project.timeline_duration_sec;
    const measure = () => {
      const { scrollbarInlinePx, scrollbarBlockPx, ...next } =
        measureTimelineColumns(el);
      setColumns((prev) => (shallow(prev, next) ? prev : next));
      // Only the stage edges read the scrollbar insets: write them straight
      // to the area, so a scrollbar coming or going moves the edges in this
      // frame without re-rendering the timeline.
      const areaStyle = areaRef.current?.style;
      areaStyle?.setProperty(
        "--timeline-scrollbar-inline",
        `${scrollbarInlinePx}px`,
      );
      areaStyle?.setProperty(
        "--timeline-scrollbar-block",
        `${scrollbarBlockPx}px`,
      );
      const timeWidth = next.timeViewportPx;
      setTimelineViewportWidth(timeWidth);
      stageHeightRef.current = el.clientHeight;
      refitLanes();
      if (useDawStore.getState().followingClientId) {
        return;
      }
      const fitted = fittedRef.current;
      if (
        !userZoomed &&
        timeWidth > 0 &&
        (fitted?.widthPx !== timeWidth || fitted.sessionSec !== sessionSec)
      ) {
        fittedRef.current = { widthPx: timeWidth, sessionSec };
        fitToWindow(timeWidth);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const header = timelineHeaderEl(el);
    if (header) {
      ro.observe(header);
    }
    return () => ro.disconnect();
  }, [
    project,
    userZoomed,
    fitToWindow,
    followingClientId,
    refitLanes,
    setTimelineViewportWidth,
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    // Run when sessionRegion changes — not on zoom ticks (pointer anchor).
    if (!el || !sessionRegion || fixedPlayhead) {
      return;
    }
    const z = useDawStore.getState().zoomPxPerSec;
    const left = sessionRegion.start_sec * z;
    const right = sessionRegion.end_sec * z;
    const viewLeft = domToLogicalScrollLeft(el.scrollLeft, leadPx);
    const viewWidth = timeViewportPx;
    const viewRight = viewLeft + viewWidth;
    if (left < viewLeft || right > viewRight) {
      const target = Math.max(0, left - Math.max(40, viewWidth * 0.15));
      writeScroll(el, target, leadPx);
      setScrollLeft(target);
    }
  }, [
    sessionRegion,
    setScrollLeft,
    fixedPlayhead,
    leadPx,
    timeViewportPx,
    writeScroll,
  ]);

  useEffect(() => {
    if (toolMode !== "blade" || commentMode) {
      setBladeHoverSec(null);
    }
  }, [toolMode, commentMode, setBladeHoverSec]);
  // The hover belongs to this view's lanes; it goes when they do.
  useEffect(() => () => setBladeHoverSec(null), [setBladeHoverSec]);

  // Stable context value: a new object would re-render the headers column and
  // every metrics reader too.
  const metrics = useMemo(
    () => ({ laneHeight, markerLaneHeight: markerLaneHeightPx }),
    [laneHeight, markerLaneHeightPx],
  );

  const sessionSec = project?.timeline_duration_sec ?? 0;
  // A fixed playhead's canvas is the session (the pads fill the viewport),
  // so the scroll range itself ends with the session end under the line.
  const { widthPx: width, durationSec: canvasSec } = fixedPlayhead
    ? fixedPlayheadCanvasSize(sessionSec, zoomPxPerSec)
    : timelineCanvasSize(sessionSec, zoomPxPerSec, timeViewportPx);
  const bladeMode = toolMode === "blade" && !commentMode;

  // Lane callbacks: one stable function each, taking the track id first, so
  // memoized lanes and clips see equal props. Hot fields (playhead, scroll)
  // are read at call time.
  const onSeek = useStableCallback((clientX: number, target: HTMLElement) => {
    const sec = clientXToTimelineSec(
      clientX,
      target,
      useDawStore.getState().scrollLeft,
      zoomPxPerSec,
      canvasSec,
    );
    void execute("transport.seek", { sec }, { skipWhen: true });
    if (bladeMode) {
      void execute("edit.bladeCut", { atTime: sec }, { skipWhen: true });
    }
  });
  const onSelectClip = useStableCallback(
    (trackId: string, clipId: string, mods?: ClipSelectMods) => {
      if (mods) {
        selectClip(clipId, trackId, mods);
        return;
      }
      setSelection({ kind: "clip", id: clipId, trackId });
    },
  );
  const onSelectTrack = useStableCallback((trackId: string) => {
    setSelection({ kind: "track", trackId });
  });
  const onSelectApplied = useStableCallback((trackId: string, id: string) =>
    setSelection({ kind: "applied", id, trackId }),
  );
  const onSelectPending = useStableCallback((trackId: string, id: string) =>
    setSelection({ kind: "pending", id, trackId }),
  );
  const onClipMovePreview = useStableCallback(
    (clipId: string, info: ClipMovePointerInfo) => {
      setMovePlacements(resolveMove(clipId, info, "preview"));
    },
  );
  const onClipMoveCommit = useStableCallback(
    (clipId: string, info: ClipMovePointerInfo) => {
      const moves = resolveMove(clipId, info, "commit");
      endMoveGesture();
      if (!movesDifferFromClips(allClips, moves)) {
        return;
      }
      void execute("edit.moveClips", { clips: moves }, { skipWhen: true });
    },
  );
  const onClipMoveCancel = useStableCallback(() => endMoveGesture());

  const scrollLeaves = (
    <>
      <TimelineScrollSync
        scrollRef={scrollRef}
        leadPx={leadPx}
        writeScroll={writeScroll}
      />
      <FixedPlayheadRecenter
        scrollRef={scrollRef}
        leadPx={leadPx}
        writeScroll={writeScroll}
        fixedPlayhead={fixedPlayhead}
        timeViewportPx={timeViewportPx}
      />
    </>
  );

  if (!project) {
    return (
      <div
        ref={areaRef}
        className={`timeline-area${fixedPlayhead ? " timeline-area--fixed-playhead" : ""}`}
        role="group"
        aria-busy="true"
        aria-label="Loading timeline"
      >
        {scrollLeaves}
        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className={
              headerSlot
                ? "timeline-lock-inner timeline-lock-inner--headers"
                : "timeline-lock-inner"
            }
          >
            {headerSlot}
            <div className="timeline-time" style={{ minInlineSize: "100%" }}>
              <div className="timeline-skeleton" aria-hidden>
                {/* Ruler + marker room, as the header chrome beside it reserves. */}
                <div
                  className="timeline-skeleton-chrome"
                  style={{
                    height: RULER_HEIGHT + loadingMetrics.markerLaneHeight,
                  }}
                />
                {[0, 1, 2].map((i) => (
                  <div key={i} className="lane-row timeline-skeleton-lane" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const laneStackHeight =
    markerLaneHeightPx + project.tracks.length * laneHeight;

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
        const playheadSec = useDawStore.getState().playheadSec;
        if (Math.abs(sec - playheadSec) * zoomPxPerSec > PLAYHEAD_MOVE_MIN_PX) {
          setPlayheadSec(sec);
        }
      }
    }
    setScrollLeft(logicalLeft);
  };

  const onBladePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!bladeMode || !lanesRef.current) {
      return;
    }
    setBladeHoverSec(
      clientXToTimelineSec(
        e.clientX,
        lanesRef.current,
        useDawStore.getState().scrollLeft,
        zoomPxPerSec,
        canvasSec,
      ),
    );
  };

  const onBladePointerLeave = () => {
    setBladeHoverSec(null);
  };

  const applyZoomAt = (nextZoom: number, clientX: number) => {
    anchoringZoom.current = true;
    noteZoomPointerClientX(clientX);
    applyAnchoredZoom(nextZoom, clientX);
    requestAnimationFrame(() => {
      anchoringZoom.current = false;
    });
  };
  applyZoomAtRef.current = applyZoomAt;

  const onTimelinePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    noteZoomPointerClientX(e.clientX);
  };

  const lockClass = headerSlot
    ? "timeline-lock-inner timeline-lock-inner--headers"
    : "timeline-lock-inner";
  const selectedCommentId = selection?.kind === "comment" ? selection.id : null;
  const staleInvalidations = showStaleInv
    ? staleBreakdown.invalidations
    : EMPTY_ARR;

  return (
    <TimelineMetricsProvider value={metrics}>
      <TimelineGestureProvider value={holdLayout}>
        <div
          ref={areaRef}
          className={`timeline-area${fixedPlayhead ? " timeline-area--fixed-playhead" : ""}`}
          data-following={followingClientId ? "" : undefined}
          data-playing={isPlaying}
          data-lane-density={
            laneHeight < COMPACT_LANE_HEIGHT ? "compact" : undefined
          }
          style={
            {
              // Timeline px geometry from utils/layout.ts; timeline.css reads it.
              "--ruler-height": `${RULER_HEIGHT}px`,
              "--marker-row-height": `${MARKER_ROW_HEIGHT}px`,
              "--lane-height": `${laneHeight}px`,
              "--marker-lane-height": `${markerLaneHeightPx}px`,
              // The stage edges start past the header column (this changes
              // only when the header resizes). measure() writes the scrollbar
              // insets directly.
              "--timeline-header-offset": `${headerOffsetPx}px`,
              // Only fixed-playhead CSS reads these; keep them off other
              // views so a resize there restyles nothing.
              ...(fixedPlayhead
                ? {
                    "--timeline-lead": `${leadPx}px`,
                    "--timeline-fixed-line": `${fixedPlayheadLinePx(headerOffsetPx, timeViewportPx)}px`,
                  }
                : {}),
              ...(followingClientId
                ? {
                    "--presence-color": presenceColorVar(followColorIndex),
                  }
                : {}),
            } as CSSProperties
          }
        >
          {scrollLeaves}
          {fixedPlayhead ? (
            <div className="playhead playhead--fixed" aria-hidden>
              <FollowPlayheadChip />
            </div>
          ) : null}
          <div
            className="timeline-scroll"
            ref={scrollRef}
            onScroll={onScroll}
            onPointerMove={onTimelinePointerMove}
          >
            <div className={lockClass}>
              {headerSlot}
              <div
                className={
                  toolMode === "blade" && !commentMode
                    ? "timeline-time timeline-blade-mode"
                    : commentMode
                      ? "timeline-time timeline-comment-mode"
                      : "timeline-time"
                }
                style={{ width }}
              >
                <TimeRuler
                  durationSec={canvasSec}
                  sessionDurationSec={sessionSec}
                  zoomPxPerSec={zoomPxPerSec}
                  hidePlayhead={fixedPlayhead}
                  onSeek={(sec) => {
                    void execute("transport.seek", { sec }, { skipWhen: true });
                    if (toolMode === "blade" && !commentMode) {
                      void execute(
                        "edit.bladeCut",
                        { atTime: sec },
                        { skipWhen: true },
                      );
                    }
                  }}
                  commentMode={commentMode}
                  onCommentAnchor={(startSec, endSec) => {
                    setCommentDraft({ startSec, endSec });
                    setActiveTab("comments");
                  }}
                  onFit={() => {
                    // fitToWindow sets the scroll; the sync effect writes it.
                    void execute("view.fit", {}, { skipWhen: true });
                  }}
                />
                <div style={{ position: "relative", width }}>
                  <MarkerLane
                    chapters={chapters}
                    socialClips={socialClips}
                    comments={comments}
                    rows={rows}
                    selectedCommentId={selectedCommentId}
                    zoomPxPerSec={zoomPxPerSec}
                    width={width}
                    onSelectChapter={(ch) => {
                      setSelection({
                        kind: "chapter",
                        id: ch.title,
                        time: ch.time,
                      });
                      setPlayheadSec(ch.time);
                    }}
                    onSelectSocial={(clip) => {
                      setSelection({ kind: "social", id: clip.id });
                      setPlayheadSec(clip.start);
                    }}
                    onSelectComment={(c) => {
                      setSelection({ kind: "comment", id: c.id });
                      setPlayheadSec(c.timeline_start);
                      setActiveTab("comments");
                    }}
                  />
                  <div
                    ref={lanesRef}
                    className={
                      movePlacements ? "timeline-clip-moving" : undefined
                    }
                    style={{ position: "relative" }}
                    onPointerMove={bladeMode ? onBladePointerMove : undefined}
                    onPointerLeave={bladeMode ? onBladePointerLeave : undefined}
                  >
                    {sessionRegion && (
                      <AuditionOverlay
                        startSec={sessionRegion.start_sec}
                        endSec={sessionRegion.end_sec}
                        zoomPxPerSec={zoomPxPerSec}
                        height={laneStackHeight - markerLaneHeightPx}
                        label={lastAgentQuery ? `“${lastAgentQuery}”` : null}
                      />
                    )}
                    {selection?.kind === "comment" &&
                      (() => {
                        const selectedComment = comments.find(
                          (c) => c.id === selection.id,
                        );
                        return selectedComment ? (
                          <CommentSelectionOverlay
                            comment={selectedComment}
                            zoomPxPerSec={zoomPxPerSec}
                            height={laneStackHeight - markerLaneHeightPx}
                          />
                        ) : null;
                      })()}
                    {!fixedPlayhead ? (
                      <Playhead height={laneStackHeight - markerLaneHeightPx} />
                    ) : null}
                    <PresenceOverlay
                      zoomPxPerSec={zoomPxPerSec}
                      height={laneStackHeight - markerLaneHeightPx}
                      tracks={project.tracks}
                      clipsByTrack={project.clips.tracks}
                      hidePlayheadForClientId={followingClientId}
                    />
                    <CommentPlaybackBubble
                      comments={comments}
                      zoomPxPerSec={zoomPxPerSec}
                      selectedCommentId={selectedCommentId}
                      visible={layers.showComments && isPlaying}
                      onSelect={(c) => {
                        setSelection({ kind: "comment", id: c.id });
                        setPlayheadSec(c.timeline_start);
                        setActiveTab("comments");
                      }}
                    />
                    {bladeMode ? (
                      <BladeGuide
                        tracks={project.tracks}
                        selectedTrackIds={selectedTrackIds}
                        zoomPxPerSec={zoomPxPerSec}
                      />
                    ) : null}
                    {project.tracks.map((track, idx) => {
                      const laneClips =
                        project.clips.tracks[track.id] ?? EMPTY_CLIPS;
                      const lanePreview = laneMovePreview({
                        trackId: track.id,
                        laneClips,
                        allClips,
                        tracks: project.tracks,
                        placements: movePlacements,
                      });
                      return (
                        <TrackLane
                          key={track.id}
                          track={track}
                          trackIndex={idx}
                          clips={laneClips}
                          width={width}
                          zoomPxPerSec={zoomPxPerSec}
                          projectPath={projectPath}
                          hasPeaks={project.peaks_index[track.id] ?? false}
                          selection={selection}
                          showLevels={layers.showLevels}
                          showEdits={layers.showEdits}
                          envelopes={project.envelopes}
                          appliedRecords={project.applied_edits.records}
                          pendingEdits={project.pending_edits}
                          onSeek={onSeek}
                          bladeMode={bladeMode}
                          canMoveClips={canMoveClips}
                          selectedClipIds={selectedClipIds}
                          previewStartById={lanePreview.previewStartById}
                          hideClipIds={lanePreview.hideIds}
                          moveGhosts={lanePreview.ghosts}
                          onClipMovePreview={onClipMovePreview}
                          onClipMoveCommit={onClipMoveCommit}
                          onClipMoveCancel={onClipMoveCancel}
                          onSelectClip={onSelectClip}
                          onSelectTrack={onSelectTrack}
                          bladeHighlight={
                            bladeMode &&
                            (selectedTrackIds.length === 0 ||
                              selectedTrackIds.includes(track.id))
                          }
                          staleWholeTrack={Boolean(
                            showStaleInv && fallbackWhole.has(track.id),
                          )}
                          showStaleInvalidations={showStaleInv}
                          staleInvalidations={staleInvalidations}
                          onSelectApplied={onSelectApplied}
                          onSelectPending={onSelectPending}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* After the scroller on purpose: at the lane floor's z, tree order
              paints the edges over it, and clips and markers stay above. */}
          <div className="timeline-edge timeline-edge--start" aria-hidden />
          <div className="timeline-edge timeline-edge--end" aria-hidden />
        </div>
      </TimelineGestureProvider>
    </TimelineMetricsProvider>
  );
}

/**
 * The arrangement view. Memoized: it selects no per-frame store fields, so a
 * playhead, scroll or presence tick re-renders only its leaves.
 */
export const TimelineView = memo(TimelineViewView);
