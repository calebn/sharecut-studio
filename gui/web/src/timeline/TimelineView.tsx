import {
  type CSSProperties,
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
import { execute } from "../commands/execute";
import {
  allClipsFromTracks,
  type ClipMoveItem,
  type ClipMovePointerInfo,
  computeClipMoves,
  laneMovePreview,
  moveSnapTicks,
  movesDifferFromClips,
  snapMoveDeltaSec,
  trackIdFromPoint,
} from "../edit/clipMove";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { presenceColorVar, rosterDisplayName } from "../presence/colors";
import {
  isProgrammaticScroll,
  withProgrammaticScroll,
} from "../presence/followSync";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { Avatar } from "../ui/Avatar";
import {
  COMPACT_LANE_HEIGHT,
  FIT_GUTTER,
  LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  RULER_HEIGHT,
} from "../utils/layout";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import {
  fixedPlayheadLeadPx,
  scrollLeftCenteringSec,
  secAtViewportCenter,
  timelineCanvasSize,
  timelineHeaderOffsetWidth,
  timelineTimeViewportWidth,
} from "../utils/timelineViewport";
import { noteZoomPointerClientX } from "../utils/zoomPointer";
import { AuditionOverlay } from "./AuditionOverlay";
import { CommentPlaybackBubble } from "./CommentPlaybackBubble";
import { CommentSelectionOverlay } from "./CommentSelectionOverlay";
import { MarkerLane } from "./MarkerLane";
import { Playhead } from "./Playhead";
import { PresenceOverlay } from "./PresenceOverlay";
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

export function TimelineView({ fixedPlayhead = false, headerSlot }: Props) {
  // Before a project loads this view provides no metrics, so its skeleton and
  // any header column beside or inside it read the same ambient defaults.
  const loadingMetrics = useTimelineMetrics();
  const {
    projectPath,
    zoomPxPerSec,
    scrollLeft,
    setScrollLeft,
    setTimelineLeadPx,
    playheadSec,
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
    sessionClients,
    localClientId,
    followingClientId,
    stopFollow,
  } = useDawStore(
    useShallow((s) => ({
      projectPath: s.projectPath,
      zoomPxPerSec: s.zoomPxPerSec,
      scrollLeft: s.scrollLeft,
      setScrollLeft: s.setScrollLeft,
      setTimelineLeadPx: s.setTimelineLeadPx,
      playheadSec: s.playheadSec,
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
      sessionClients: s.sessionClients,
      localClientId: s.localClientId,
      followingClientId: s.followingClientId,
      stopFollow: s.stopFollow,
    })),
  );
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
  const timeRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const prevZoomForPlayheadRef = useRef(zoomPxPerSec);
  const applyZoomAtRef = useRef<(nextZoom: number, clientX: number) => void>(
    () => undefined,
  );
  const [bladeHoverSec, setBladeHoverSec] = useState<number | null>(null);
  const [timeViewportPx, setTimeViewportPx] = useState(0);
  // Fixed playhead: pad the time column by half the viewport on each side so
  // every time, 0 and the end included, can sit under the centre line. Store
  // scroll stays logical; the DOM scroll is logical + leadPx.
  const leadPx = fixedPlayhead ? fixedPlayheadLeadPx(timeViewportPx) : 0;
  useEffect(() => {
    setTimelineLeadPx(leadPx);
    return () => setTimelineLeadPx(0);
  }, [leadPx, setTimelineLeadPx]);
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
      playheadSec,
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
      () => timeRef.current ?? el,
    );
  }, [project, setTimelineFocused]);

  // Fit-to-window lanes: few tracks grow to fill the stage. The stage height
  // lives in a ref; state changes only when the whole-px lane height does, so
  // a vertical resize (e.g. the tabs splitter) does not re-render every clip.
  const liveRows = markerRows({
    chapters: project?.chapters ?? [],
    socialClips: project?.social_clips ?? [],
    comments: project?.comments ?? [],
    showMarkers: layers.showMarkers,
    showComments: layers.showComments,
  });
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
  const { value: layout, hold: holdLayout } = useGestureStable({
    laneHeight: fittedLaneHeight,
    markerLaneHeightPx: liveMarkerLaneHeightPx,
    rows: liveRows,
  });
  const { laneHeight, markerLaneHeightPx, rows } = layout;
  const moving = movePlacements != null;
  useEffect(() => (moving ? holdLayout() : undefined), [moving, holdLayout]);

  // One observer on the scroller: width drives fit-to-window zoom, height the
  // lane fit. Layout effect so the first frame already has both.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !project) {
      return;
    }
    const applyFit = (scrollWidth: number) => {
      const headerW = timelineHeaderOffsetWidth(el);
      const timeWidth = Math.max(0, scrollWidth - headerW);
      setTimeViewportPx(timeWidth);
      if (useDawStore.getState().followingClientId) {
        return;
      }
      if (!userZoomed && timeWidth > 0) {
        fitToWindow(timeWidth);
        // Logical 0 (fitToWindow's scroll) past any fixed-playhead lead pad.
        withProgrammaticScroll(() => {
          el.scrollLeft = fixedPlayhead ? fixedPlayheadLeadPx(timeWidth) : 0;
        });
      }
    };
    const measure = (width: number, height: number) => {
      applyFit(width);
      stageHeightRef.current = height;
      refitLanes();
    };
    measure(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        measure(entry.contentRect.width, entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    project,
    userZoomed,
    fitToWindow,
    followingClientId,
    refitLanes,
    fixedPlayhead,
  ]);

  useLayoutEffect(() => {
    if (!fixedPlayhead) {
      return;
    }
    const el = scrollRef.current;
    const area = areaRef.current;
    if (!el || !area) {
      return;
    }
    const syncOffset = () => {
      area.style.setProperty(
        "--timeline-header-offset",
        `${timelineHeaderOffsetWidth(el)}px`,
      );
    };
    syncOffset();
    const ro = new ResizeObserver(syncOffset);
    ro.observe(el);
    const header = el.querySelector(".track-headers");
    if (header) {
      ro.observe(header);
    }
    return () => ro.disconnect();
  }, [project, headerSlot, fixedPlayhead]);

  // Apply store scroll after zoom expands content width (avoids clamp on fitted views).
  // Also runs in fixed-playhead mode so pinch/cursor anchors are not discarded.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const domLeft = scrollLeft + leadPx;
    if (Math.abs(el.scrollLeft - domLeft) <= 0.5) {
      return;
    }
    syncingScroll.current = true;
    withProgrammaticScroll(() => {
      el.scrollLeft = domLeft;
    });
    requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  }, [scrollLeft, zoomPxPerSec, leadPx]);

  useEffect(() => {
    const el = scrollRef.current;
    // Run when sessionRegion changes — not on zoom ticks (pointer anchor).
    if (!el || !sessionRegion || fixedPlayhead) {
      return;
    }
    const z = useDawStore.getState().zoomPxPerSec;
    const left = sessionRegion.start_sec * z;
    const right = sessionRegion.end_sec * z;
    const viewLeft = el.scrollLeft;
    const viewWidth = timelineTimeViewportWidth(el);
    const viewRight = viewLeft + viewWidth;
    if (left < viewLeft || right > viewRight) {
      const target = Math.max(0, left - Math.max(40, viewWidth * 0.15));
      withProgrammaticScroll(() => {
        el.scrollLeft = target;
      });
      setScrollLeft(target);
    }
  }, [sessionRegion, setScrollLeft, fixedPlayhead]);

  // Fixed playhead: transport/seek recenters on the playhead. Pointer and
  // pinch zoom keep the time under the fingers stable and move the playhead to
  // the new viewport center; fit and other unanchored zoom keep the playhead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !fixedPlayhead || !project) {
      return;
    }
    const durationSec = project.timeline_duration_sec;
    const zoomChanged = prevZoomForPlayheadRef.current !== zoomPxPerSec;
    prevZoomForPlayheadRef.current = zoomPxPerSec;
    const viewWidth = timelineTimeViewportWidth(el);

    if (zoomChanged && userZoomed) {
      const canvasSec = timelineCanvasSize(
        durationSec,
        zoomPxPerSec,
        viewWidth,
      ).durationSec;
      const centerSec = secAtViewportCenter(
        scrollLeft,
        zoomPxPerSec,
        viewWidth,
        canvasSec,
      );
      if (Math.abs(centerSec - playheadSec) > 1e-3) {
        setPlayheadSec(centerSec);
      }
      return;
    }

    const target = scrollLeftCenteringSec(playheadSec, zoomPxPerSec, viewWidth);
    if (Math.abs(el.scrollLeft - leadPx - target) > 1) {
      syncingScroll.current = true;
      withProgrammaticScroll(() => {
        el.scrollLeft = target + leadPx;
      });
      setScrollLeft(target);
      requestAnimationFrame(() => {
        syncingScroll.current = false;
      });
    }
  }, [
    playheadSec,
    zoomPxPerSec,
    scrollLeft,
    fixedPlayhead,
    project,
    setScrollLeft,
    setPlayheadSec,
    isPlaying,
    userZoomed,
    leadPx,
  ]);

  useEffect(() => {
    if (toolMode !== "blade" || commentMode) {
      setBladeHoverSec(null);
    }
  }, [toolMode, commentMode]);

  // Stable context value: TimelineView renders every playhead tick, and a new
  // object would re-render the headers column and every metrics reader too.
  const metrics = useMemo(
    () => ({ laneHeight, markerLaneHeight: markerLaneHeightPx }),
    [laneHeight, markerLaneHeightPx],
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

  const sessionSec = project.timeline_duration_sec;
  const { widthPx: width, durationSec: canvasSec } = timelineCanvasSize(
    sessionSec,
    zoomPxPerSec,
    timeViewportPx,
  );
  const laneStackHeight =
    markerLaneHeightPx + project.tracks.length * laneHeight;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const logicalLeft = el.scrollLeft - leadPx;
    setScrollLeft(logicalLeft);
    if (
      followingClientId &&
      !syncingScroll.current &&
      !isProgrammaticScroll()
    ) {
      stopFollow("local");
    }
    // Only a person's scroll seeks: fit, recentring and follow scrolls are
    // programmatic, and sub-pixel clamps or rounding must not move the time.
    if (fixedPlayhead && !syncingScroll.current && !isProgrammaticScroll()) {
      const sec = secAtViewportCenter(
        logicalLeft,
        zoomPxPerSec,
        timelineTimeViewportWidth(el),
        canvasSec,
      );
      if (Math.abs(sec - playheadSec) * zoomPxPerSec > 1) {
        setPlayheadSec(sec);
      }
    }
  };

  const seekAt = (clientX: number, target: HTMLElement) => {
    const sec = clientXToTimelineSec(
      clientX,
      target,
      scrollLeft,
      zoomPxPerSec,
      canvasSec,
    );
    void execute("transport.seek", { sec }, { skipWhen: true });
    if (toolMode === "blade" && !commentMode) {
      void execute("edit.bladeCut", { atTime: sec }, { skipWhen: true });
    }
  };

  const bladeMode = toolMode === "blade" && !commentMode;

  const onBladePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!bladeMode || !lanesRef.current) {
      return;
    }
    setBladeHoverSec(
      clientXToTimelineSec(
        e.clientX,
        lanesRef.current,
        scrollLeft,
        zoomPxPerSec,
        canvasSec,
      ),
    );
  };

  const onBladePointerLeave = () => {
    setBladeHoverSec(null);
  };

  const applyZoomAt = (nextZoom: number, clientX: number) => {
    syncingScroll.current = true;
    noteZoomPointerClientX(clientX);
    applyAnchoredZoom(nextZoom, clientX);
    requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  };
  applyZoomAtRef.current = applyZoomAt;

  const onTimelinePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    noteZoomPointerClientX(e.clientX);
  };

  const lockClass = headerSlot
    ? "timeline-lock-inner timeline-lock-inner--headers"
    : "timeline-lock-inner";
  const followTarget = followingClientId
    ? sessionClients.find((c) => c.client_id === followingClientId)
    : undefined;

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
              "--timeline-lead": `${leadPx}px`,
              ...(followingClientId
                ? {
                    "--presence-color": presenceColorVar(
                      followTarget?.meta?.color_index,
                    ),
                  }
                : {}),
            } as CSSProperties
          }
        >
          {fixedPlayhead ? (
            <div className="playhead playhead--fixed" aria-hidden>
              {followTarget ? (
                <span className="playhead-fixed-chip">
                  <Avatar
                    name={rosterDisplayName(followTarget)}
                    colorIndex={followTarget.meta?.color_index}
                    sessionRole={followTarget.role}
                    size="sm"
                  />
                </span>
              ) : null}
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
                ref={timeRef}
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
                  playheadSec={playheadSec}
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
                    void execute("view.fit", {}, { skipWhen: true });
                    if (scrollRef.current) {
                      withProgrammaticScroll(() => {
                        scrollRef.current!.scrollLeft = leadPx;
                      });
                    }
                  }}
                />
                <div style={{ position: "relative", width }}>
                  <MarkerLane
                    chapters={project.chapters}
                    socialClips={project.social_clips ?? []}
                    comments={project.comments ?? []}
                    rows={rows}
                    selectedCommentId={
                      selection?.kind === "comment" ? selection.id : null
                    }
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
                        const selectedComment = (project.comments ?? []).find(
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
                      <Playhead
                        playheadSec={playheadSec}
                        zoomPxPerSec={zoomPxPerSec}
                        height={laneStackHeight - markerLaneHeightPx}
                      />
                    ) : null}
                    <PresenceOverlay
                      clients={sessionClients}
                      localClientId={localClientId}
                      zoomPxPerSec={zoomPxPerSec}
                      height={laneStackHeight - markerLaneHeightPx}
                      tracks={project.tracks}
                      clipsByTrack={project.clips.tracks}
                      hidePlayheadForClientId={followingClientId}
                    />
                    <CommentPlaybackBubble
                      comments={project.comments ?? []}
                      playheadSec={playheadSec}
                      zoomPxPerSec={zoomPxPerSec}
                      selectedCommentId={
                        selection?.kind === "comment" ? selection.id : null
                      }
                      visible={layers.showComments && isPlaying}
                      onSelect={(c) => {
                        setSelection({ kind: "comment", id: c.id });
                        setPlayheadSec(c.timeline_start);
                        setActiveTab("comments");
                      }}
                    />
                    {project.tracks.map((track, idx) => {
                      const lanePreview = laneMovePreview({
                        trackId: track.id,
                        laneClips: project.clips.tracks[track.id] ?? [],
                        allClips,
                        tracks: project.tracks,
                        placements: movePlacements,
                      });
                      return (
                        <TrackLane
                          key={track.id}
                          track={track}
                          trackIndex={idx}
                          clips={project.clips.tracks[track.id] ?? []}
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
                          onSeek={seekAt}
                          bladeMode={bladeMode}
                          bladeHoverSec={bladeHoverSec}
                          canMoveClips={canMoveClips}
                          selectedClipIds={selectedClipIds}
                          previewStartById={lanePreview.previewStartById}
                          hideClipIds={lanePreview.hideIds}
                          moveGhosts={lanePreview.ghosts}
                          onClipMovePreview={(clipId, info) => {
                            setMovePlacements(
                              resolveMove(clipId, info, "preview"),
                            );
                          }}
                          onClipMoveCommit={(clipId, info) => {
                            const moves = resolveMove(clipId, info, "commit");
                            endMoveGesture();
                            if (!movesDifferFromClips(allClips, moves)) {
                              return;
                            }
                            void execute(
                              "edit.moveClips",
                              { clips: moves },
                              { skipWhen: true },
                            );
                          }}
                          onClipMoveCancel={() => endMoveGesture()}
                          onSelectClip={(clipId, mods) => {
                            if (mods) {
                              selectClip(clipId, track.id, mods);
                              return;
                            }
                            setSelection({
                              kind: "clip",
                              id: clipId,
                              trackId: track.id,
                            });
                          }}
                          onSelectTrack={() => {
                            setSelection({ kind: "track", trackId: track.id });
                          }}
                          bladeHighlight={
                            bladeMode &&
                            (selectedTrackIds.length === 0 ||
                              selectedTrackIds.includes(track.id))
                          }
                          staleWholeTrack={Boolean(
                            showStaleInv && fallbackWhole.has(track.id),
                          )}
                          showStaleInvalidations={showStaleInv}
                          staleInvalidations={
                            showStaleInv ? staleBreakdown.invalidations : []
                          }
                          onSelectApplied={(id) =>
                            setSelection({
                              kind: "applied",
                              id,
                              trackId: track.id,
                            })
                          }
                          onSelectPending={(id) =>
                            setSelection({
                              kind: "pending",
                              id,
                              trackId: track.id,
                            })
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </TimelineGestureProvider>
    </TimelineMetricsProvider>
  );
}
