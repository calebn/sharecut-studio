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
  useSyncExternalStore,
} from "react";
import { shallow } from "zustand/shallow";
import { runPointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
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
import { useProsodyOverlayViews } from "../prosody/useProsodyOverlay";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import type { DawState } from "../state/types";
import { pickDaw, useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import type { ProsodyOverlayTrack } from "../types/prosody";
import { useResizeObserver } from "../ui/useResizeObserver";
import { pendingEditTrackIds } from "../utils/edits";
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
  fixedPlayheadLinePx,
  measureTimelineColumns,
  timelineHeaderEl,
} from "../utils/timelineViewport";
import { useStableCallback } from "../utils/useStableCallback";
import { noteZoomPointerClientX } from "../utils/zoomPointer";
import {
  getRasterBackend,
  subscribeRasterBackend,
} from "../waveform/rasterClient";
import { WaveformStatusSync } from "../waveform/WaveformStatusSync";
import { AuditionOverlay } from "./AuditionOverlay";
import { CommentPlaybackBubble } from "./CommentPlaybackBubble";
import { CommentSelectionOverlay } from "./CommentSelectionOverlay";
import { clippingFlags } from "./clippingFlags";
import { selectFollowColorIndex } from "./followTarget";
import {
  appliedRecordTrackIds,
  envelopeTrackIds,
  useByTrack,
} from "./laneOverlaySlices";
import { MarkerLane } from "./MarkerLane";
import { Playhead } from "./Playhead";
import { PresenceOverlay } from "./PresenceOverlay";
import { ProsodyStatusAnnouncer } from "./ProsodyStatusAnnouncer";
import { RecordingOverlay, RecordingScrollExtent } from "./RecordingOverlay";
import { BladeGuide, FollowPlayheadChip } from "./TimelineLeaves";
import { TimeRuler } from "./TimeRuler";
import { TrackLane } from "./TrackLane";
import {
  markerLaneHeight,
  markerRows,
  resolveLaneHeight,
  TimelineGestureProvider,
  TimelineMetricsProvider,
  useGestureStable,
  useTimelineMetrics,
} from "./timelineMetrics";
import { attachTimelineZoomGestures } from "./timelineZoomGestures";
import {
  FixedPlayheadRecenter,
  TimelineScrollSync,
  useFixedPlayheadScroll,
} from "./useFixedPlayheadScroll";

type Props = {
  /** Phone Timeline mode: playhead fixed at viewport center; scrub by scrolling. */
  fixedPlayhead?: boolean;
  /** Desktop/tablet track headers locked into the same scroller as the lanes. */
  headerSlot?: ReactNode;
};

const selectTimelineViewFields = pickDaw(
  "projectPath",
  "zoomPxPerSec",
  "setScrollLeft",
  "setPlayheadSec",
  "selection",
  "setSelection",
  "userZoomed",
  "setTimelineFocused",
  "layers",
  "fitToWindow",
  "sessionRegion",
  "lastAgentQuery",
  "commentMode",
  "setCommentDraft",
  "setActiveTab",
  "isPlaying",
  "toolMode",
  "selectedTrackIds",
  "selectedClipIds",
  "selectClip",
  "guestMode",
  "shareCapabilities",
  "highlightStaleRender",
  "followingClientId",
  "setBladeHoverSec",
  "setTimelineViewportWidth",
  "laneHeightMode",
  "laneHeightPx",
  "pointerKind",
);

const selectTimelineProject = (s: DawState) => {
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
    chapters: p.chapters,
    social_clips: p.social_clips,
    render_status: p.render_status,
  };
};

export function TimelineViewView({ fixedPlayhead = false, headerSlot }: Props) {
  // Before a project loads this view provides no metrics, so its skeleton and
  // any header column beside or inside it read the same ambient defaults.
  const loadingMetrics = useTimelineMetrics();
  const {
    projectPath,
    zoomPxPerSec,
    setScrollLeft,
    setPlayheadSec,
    selection,
    setSelection,
    userZoomed,
    setTimelineFocused,
    layers,
    fitToWindow,
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
    setBladeHoverSec,
    setTimelineViewportWidth,
    laneHeightMode,
    laneHeightPx,
    pointerKind,
  } = useDaw(selectTimelineViewFields);
  const followColorIndex = useDawStore(selectFollowColorIndex);
  const waveformBackend = useSyncExternalStore(
    subscribeRasterBackend,
    getRasterBackend,
    () => "none",
  );
  const project = useDaw(selectTimelineProject);
  // `aligned` draws lane geometry; `latest` feeds the status summary so it does not blank and
  // re-announce after every clip edit.
  const { aligned: prosody, latest: prosodyLatest } = useProsodyOverlayViews(
    layers.showProsody,
  );
  const prosodyByTrack = useMemo(
    () =>
      new Map<string, ProsodyOverlayTrack>(
        (prosody?.tracks ?? []).map((t) => [t.track_id, t]),
      ),
    [prosody],
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
  const scroll = useFixedPlayheadScroll({
    scrollRef,
    fixedPlayhead,
    timeViewportPx,
    sessionSec: project?.timeline_duration_sec ?? 0,
    zoomPxPerSec,
    followingClientId,
  });
  const {
    leadPx,
    canvas: { widthPx: width, durationSec: canvasSec },
    writeScroll,
  } = scroll;
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
    timelineViewportRegistry.setTimelineElement(scrollRef.current);
    timelineViewportRegistry.setLanesElement(lanesRef.current);
    return () => {
      timelineViewportRegistry.setTimelineElement(null);
      timelineViewportRegistry.setLanesElement(null);
    };
  }, [project]);

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
  const clipFlags = useMemo(
    () =>
      project ? clippingFlags(project.clips.tracks, project.tracks) : EMPTY_ARR,
    [project],
  );
  const liveRows = useMemo(
    () =>
      markerRows({
        chapters,
        socialClips,
        comments,
        clippingFlags: clipFlags,
        showMarkers: layers.showMarkers,
        showComments: layers.showComments,
      }),
    [
      chapters,
      socialClips,
      comments,
      clipFlags,
      layers.showMarkers,
      layers.showComments,
    ],
  );
  const liveMarkerLaneHeightPx = markerLaneHeight(liveRows);
  const trackCount = project?.tracks.length ?? 0;
  const [fittedLaneHeight, setFittedLaneHeight] = useState(LANE_HEIGHT);
  const fittedLaneHeightRef = useRef(LANE_HEIGHT);
  const stageHeightRef = useRef(0);
  const fitInputsRef = useRef({
    trackCount,
    markerLaneHeightPx: liveMarkerLaneHeightPx,
    mode: laneHeightMode,
    fixedPx: laneHeightPx,
    minimumPx:
      fixedPlayhead || pointerKind === "coarse"
        ? COMPACT_LANE_HEIGHT
        : LANE_HEIGHT,
  });
  const refitLanes = useCallback(() => {
    const inputs = fitInputsRef.current;
    const next = resolveLaneHeight({
      mode: inputs.mode,
      fixedPx: inputs.fixedPx,
      availablePx:
        stageHeightRef.current -
        RULER_HEIGHT -
        inputs.markerLaneHeightPx -
        FIT_GUTTER,
      trackCount: inputs.trackCount,
      minimumPx: inputs.minimumPx,
    });
    useDawStore.getState().setDrawnLaneHeightPx(next);
    if (next !== fittedLaneHeightRef.current) {
      fittedLaneHeightRef.current = next;
      setFittedLaneHeight(next);
    }
  }, []);

  // Tracks, marker rows, or the height mode/preference changed without a
  // resize: re-resolve from the last measured stage. Declared before the
  // observer so its inputs are current.
  useLayoutEffect(() => {
    fitInputsRef.current = {
      trackCount,
      markerLaneHeightPx: liveMarkerLaneHeightPx,
      mode: laneHeightMode,
      fixedPx: laneHeightPx,
      minimumPx:
        fixedPlayhead || pointerKind === "coarse"
          ? COMPACT_LANE_HEIGHT
          : LANE_HEIGHT,
    };
    refitLanes();
  }, [
    trackCount,
    liveMarkerLaneHeightPx,
    laneHeightMode,
    laneHeightPx,
    fixedPlayhead,
    pointerKind,
    refitLanes,
  ]);

  // Lane geometry as drawn: held still while a move / trim / fade / envelope
  // drag is active (children hold via useHoldTimelineMetrics, or the envelope
  // drag's pointerdown via useTimelineGestureHold).
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
  // One observer (ui/useResizeObserver) on the scroller and its header
  // column, used only as a trigger: every measurement reads the element
  // (clientWidth), the same source as fit commands, zoom anchoring and
  // presence. The time viewport drives the fit, the lead pads and the fixed
  // line; the height the lanes.
  const measure = useStableCallback(() => {
    const el = scrollRef.current;
    if (!el || !project) {
      return;
    }
    const sessionSec = project.timeline_duration_sec;
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
    // Fixed mode ignores the stage height; the layout effect above
    // re-resolves when the mode or fixed px changes.
    if (fitInputsRef.current.mode === "fit") {
      refitLanes();
    }
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
  });
  // First measure in a layout effect so the first frame is already fitted;
  // re-measure when the fit inputs change without a resize.
  useLayoutEffect(() => {
    measure();
  }, [
    measure,
    project,
    userZoomed,
    fitToWindow,
    followingClientId,
    refitLanes,
    setTimelineViewportWidth,
  ]);
  useResizeObserver(
    [scrollRef, () => timelineHeaderEl(scrollRef.current)],
    measure,
    project != null,
  );

  // Unmounting (shell switch, project close) drops the measured width and
  // drawn lane height, so the next timeline's first render uses the shell
  // estimate and a height step falls back to the saved fixed px.
  useLayoutEffect(
    () => () => {
      const s = useDawStore.getState();
      s.resetTimelineViewportWidth();
      s.setDrawnLaneHeightPx(null);
    },
    [],
  );

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
    void seekTransport(sec);
    setSelection(null);
    if (bladeMode) {
      runPointerCommand("edit.bladeCut", { atTime: sec });
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
      if (!movesDifferFromClips(allClips, moves, zoomPxPerSec)) {
        return;
      }
      runPointerCommand("edit.moveClips", { clips: moves });
    },
  );
  const onClipMoveCancel = useStableCallback(() => endMoveGesture());

  // Per-track slices: a lane's own array keeps its identity across renders
  // when nothing on that track changed, so TrackLane's memo bails out for
  // untouched lanes even when another lane's envelope/edit list changed.
  const envelopeSlices = useByTrack(
    project?.envelopes ?? EMPTY_ARR,
    envelopeTrackIds,
  );
  const pendingEditSlices = useByTrack(
    project?.pending_edits ?? EMPTY_ARR,
    pendingEditTrackIds,
  );
  const appliedRecordSlices = useByTrack(
    project?.applied_edits.records ?? EMPTY_ARR,
    appliedRecordTrackIds,
  );

  const scrollLeaves = (
    <>
      <TimelineScrollSync binding={scroll.binding} />
      <FixedPlayheadRecenter binding={scroll.binding} />
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

  applyZoomAtRef.current = scroll.applyZoomAt;

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
          data-pointer-kind={pointerKind}
          data-waveform-backend={waveformBackend}
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
          <WaveformStatusSync />
          {layers.showProsody ? (
            <ProsodyStatusAnnouncer overlay={prosodyLatest} />
          ) : null}
          {fixedPlayhead ? (
            <div className="playhead playhead--fixed" aria-hidden>
              <FollowPlayheadChip />
            </div>
          ) : null}
          <div
            className="timeline-scroll"
            ref={scrollRef}
            onScroll={scroll.onScroll}
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
                <RecordingOverlay
                  zoomPxPerSec={zoomPxPerSec}
                  trailingPadPx={leadPx}
                />
                <TimeRuler
                  durationSec={canvasSec}
                  sessionDurationSec={sessionSec}
                  zoomPxPerSec={zoomPxPerSec}
                  hidePlayhead={fixedPlayhead}
                  onSeek={(sec) => {
                    void seekTransport(sec);
                    setSelection(null);
                    if (toolMode === "blade" && !commentMode) {
                      runPointerCommand("edit.bladeCut", { atTime: sec });
                    }
                  }}
                  commentMode={commentMode}
                  onCommentAnchor={(startSec, endSec) => {
                    setCommentDraft({ startSec, endSec });
                    setActiveTab("comments");
                  }}
                  onFit={() => {
                    // fitToWindow sets the scroll; the sync effect writes it.
                    runPointerCommand("view.fit");
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
                    clippingFlags={clipFlags}
                    onSelectClipping={(flag) => {
                      setSelection({ kind: "track", trackId: flag.trackId });
                      setPlayheadSec(flag.start);
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
                          selection={selection}
                          showLevels={layers.showLevels}
                          showEdits={layers.showEdits}
                          envelopes={envelopeSlices[track.id] ?? EMPTY_ARR}
                          appliedRecords={
                            appliedRecordSlices[track.id] ?? EMPTY_ARR
                          }
                          pendingEdits={
                            pendingEditSlices[track.id] ?? EMPTY_ARR
                          }
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
                          onSelectPending={onSelectPending}
                          prosody={prosodyByTrack.get(track.id) ?? null}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
              <RecordingScrollExtent
                zoomPxPerSec={zoomPxPerSec}
                timelineWidthPx={width}
              />
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
