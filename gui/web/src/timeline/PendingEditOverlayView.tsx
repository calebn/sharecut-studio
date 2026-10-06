import type { CSSProperties } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isHandleDrag } from "../edit/dragThreshold";
import { useWaveformSnapTicks } from "../hooks/useWaveformSnapTicks";
import {
  REFINE_GATE_GUI_MESSAGE,
  TranscriptRefineRecovery,
} from "../inspector/TranscriptRefineRecovery";
import { useQueuedReviewNotice } from "../inspector/useQueuedReviewNotice";
import { canRetimePendingEdit, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow, PendingEditView } from "../types/project";
import { Button } from "../ui/Button";
import { useResizeObserver } from "../ui/useResizeObserver";
import {
  ApiError,
  errorMessage,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../utils/apiError";
import { pendingEditTrackIds } from "../utils/edits";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../utils/pendingEditLabels";
import { pendingEditTimingFieldId } from "../utils/pendingEditTimingField";
import { formatTimeMs } from "../utils/time";
import { clipsForOriginTrack } from "../utils/timebase";
import { HIT_SURFACE_PROPS, hitTargetProps } from "./hitTargets";
import {
  type PendingActionPlacement,
  placePendingActionbar,
} from "./pendingActionPlacement";
import {
  canShowPendingCoarseHandles,
  pendingCoarseHandleCenters,
} from "./pendingCoarseControls";
import {
  type PendingDragEdge,
  pendingEdgePlacement,
  pendingEdgePreview,
  pendingOuterEndpoint,
} from "./pendingEdgeDrag";
import { pendingOverlayWidthPx } from "./pendingOverlayWidth";

type ReviewAction = "approve" | "reject";
type ReviewResult = { queued: boolean };

export interface PendingEditOverlayViewProps {
  edits: readonly PendingEditView[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
  projectPath: string;
  timelineWidthPx: number;
  clipsByTrack: Record<string, ClipRow[]>;
  canAdjust: boolean;
  canApply: boolean;
  onSelect: (id: string) => void;
  onCommitSpan: (
    projectPath: string,
    projectEpoch: number,
    editId: string,
    expectedSourceStart: number,
    expectedSourceEnd: number,
    sourceStart: number,
    sourceEnd: number,
  ) => Promise<void> | void;
  onReviewAction: (
    projectPath: string,
    projectEpoch: number,
    editId: string,
    action: ReviewAction,
  ) => Promise<ReviewResult>;
}

type DragCapture = {
  pointerId: number;
  projectPath: string;
  projectEpoch: number;
  editId: string;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  edge: PendingDragEdge;
  originX: number;
  placement: NonNullable<ReturnType<typeof pendingEdgePlacement>>;
  controller: AbortController;
};

type Gesture =
  | { kind: "idle" }
  | ({ kind: "dragging"; sourceDeltaSec: number } & DragCapture)
  | ({
      kind: "settling";
      sourceDeltaSec: number;
      preview: NonNullable<ReturnType<typeof pendingEdgePreview>>;
    } & DragCapture);

const IDLE: Gesture = { kind: "idle" };
const ACTION_BAR_WIDTH_REM = 15;
const VIEWPORT_GUTTER_REM = 0.5;
const LABEL_INLINE_WIDTH_REM = 9;

function rootRem(): number {
  return (
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  );
}

function touchTargetPx(): number {
  const targetRem = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--touch-min"),
  );
  return targetRem * rootRem();
}

function labelFor(edit: PendingEditView): string {
  if (edit.exact_range) {
    const islands = edit.exact_range.intervals
      .map((r) => `${formatTimeMs(r.start)} – ${formatTimeMs(r.end)}`)
      .join(" · ");
    return `${pendingTypeLabel(edit.type)} ${islands} · ${edit.exact_range.track_ids.join(", ")} · pending`;
  }
  if (edit.source_start == null || edit.source_end == null)
    return `${pendingTypeLabel(edit.type)} · source bounds unavailable`;
  const duration = Math.max(0, edit.source_end - edit.source_start);
  const durationLabel = `${duration.toFixed(1)}s`;
  const status = edit.reason?.includes(":suggest") ? "suggested" : "pending";
  return `${pendingTypeLabel(edit.type)} ${durationLabel} · ${status}`;
}

function viewportPosition(anchor: HTMLElement): { left: number; top: number } {
  const bounds = anchor.getBoundingClientRect();
  const rem = rootRem();
  const gutter = VIEWPORT_GUTTER_REM * rem;
  const width = ACTION_BAR_WIDTH_REM * rem;
  const left = Math.min(
    Math.max(gutter, bounds.left),
    Math.max(gutter, window.innerWidth - width - gutter),
  );
  const top = Math.min(
    Math.max(gutter, bounds.top),
    Math.max(gutter, window.innerHeight - 8 * rem - gutter),
  );
  return { left, top };
}

function PendingEditRegion({
  edit,
  span,
  spanIndex,
  trackId,
  zoomPxPerSec,
  selected,
  projectPath,
  timelineWidthPx,
  clipsByTrack,
  canAdjust,
  canApply,
  onSelect,
  onCommitSpan,
  onReviewAction,
}: {
  edit: PendingEditView;
  span: PendingEditView["timeline_spans"][number];
  spanIndex: number;
  trackId: string;
  zoomPxPerSec: number;
  selected: boolean;
  projectPath: string;
  timelineWidthPx: number;
  clipsByTrack: Record<string, ClipRow[]>;
  canAdjust: boolean;
  canApply: boolean;
  onSelect: (id: string) => void;
  onCommitSpan: PendingEditOverlayViewProps["onCommitSpan"];
  onReviewAction: PendingEditOverlayViewProps["onReviewAction"];
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const actionbarRef = useRef<HTMLDivElement>(null);
  const scheduleResizeUpdateRef = useRef<(() => void) | null>(null);
  const currentGesture = useRef<Gesture>(IDLE);
  const commitPendingRef = useRef(false);
  const wasSelected = useRef(selected);
  const [gesture, setGesture] = useState<Gesture>(IDLE);
  const [actionState, setActionState] = useState<
    | { kind: "idle" }
    | { kind: "busy"; action: ReviewAction }
    | { kind: "error"; message: string; code: string | null }
  >({ kind: "idle" });
  const { notice: queuedNotice, setQueued } =
    useQueuedReviewNotice(projectPath);
  const [portalPosition, setPortalPosition] = useState({ left: 0, top: 0 });
  const [actionbarPlacement, setActionbarPlacement] =
    useState<PendingActionPlacement | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [overlayHeightPx, setOverlayHeightPx] = useState(0);
  const [labelActive, setLabelActive] = useState(false);
  const edgeHintId = useId();
  const projectEpoch = useDawStore((state) => state.projectEpoch);
  const pointerKind = useDawStore((state) => state.pointerKind);

  const isSplit = edit.type === "split";
  const originClips = useMemo(
    () => clipsForOriginTrack(clipsByTrack, edit.track_id),
    [clipsByTrack, edit.track_id],
  );
  const isOriginLane = trackId === edit.track_id;
  const startPlacement =
    isOriginLane && edit.source_start != null && !edit.exact_range
      ? pendingEdgePlacement(
          originClips,
          edit.source_start,
          edit.source_start_timeline ?? Number.NaN,
        )
      : null;
  const endPlacement =
    isOriginLane && edit.source_end != null && !edit.exact_range
      ? pendingEdgePlacement(
          originClips,
          edit.source_end,
          edit.source_end_timeline ?? Number.NaN,
        )
      : null;
  const canDragStart =
    !isSplit &&
    canAdjust &&
    pendingOuterEndpoint(
      "start",
      edit.source_start_timeline,
      edit.timeline_spans[0]?.start ?? span.start,
      edit.timeline_spans.at(-1)?.end ?? span.end,
    ) &&
    edit.source_start_timeline != null &&
    startPlacement != null &&
    spanIndex === 0;
  const canDragEnd =
    !isSplit &&
    canAdjust &&
    pendingOuterEndpoint(
      "end",
      edit.source_end_timeline,
      edit.timeline_spans[0]?.start ?? span.start,
      edit.timeline_spans.at(-1)?.end ?? span.end,
    ) &&
    edit.source_end_timeline != null &&
    endPlacement != null &&
    spanIndex === edit.timeline_spans.length - 1;
  const dragging = gesture.kind !== "idle";
  const sourceFocus = dragging
    ? (gesture.edge === "start" ? gesture.sourceStart : gesture.sourceEnd) +
      gesture.sourceDeltaSec
    : null;
  const snapResource = useWaveformSnapTicks(
    dragging ? gesture.projectPath : projectPath,
    dragging ? gesture.trackId : edit.track_id,
    sourceFocus,
    dragging && canAdjust,
  );
  const ticks = snapResource.ticks;
  const livePreview =
    dragging && gesture.editId === edit.id
      ? gesture.kind === "settling"
        ? gesture.preview
        : pendingEdgePreview({
            edge: gesture.edge,
            sourceStart: gesture.sourceStart,
            sourceEnd: gesture.sourceEnd,
            sourceDeltaSec: gesture.sourceDeltaSec,
            placement: gesture.placement,
            ticks,
            zoomPxPerSec,
          })
      : null;
  const start =
    livePreview && gesture.kind !== "idle" && gesture.edge === "start"
      ? livePreview.timelinePoint
      : span.start;
  const end =
    livePreview && gesture.kind !== "idle" && gesture.edge === "end"
      ? livePreview.timelinePoint
      : span.end;
  const visibleWidth = pendingOverlayWidthPx(
    edit.type,
    (end - start) * zoomPxPerSec,
  );
  const regionCenter = ((start + end) / 2) * zoomPxPerSec;
  const hitWidth = Math.max(visibleWidth, 0.75 * rootRem());
  const hitCenter = Math.min(
    Math.max(regionCenter, hitWidth / 2),
    Math.max(hitWidth / 2, timelineWidthPx - hitWidth / 2),
  );
  const coarsePointer = pointerKind === "coarse";
  const coarseTargetPx = touchTargetPx();
  const coarseHandleGeometryReady =
    coarsePointer &&
    selected &&
    canShowPendingCoarseHandles(visibleWidth, overlayHeightPx, coarseTargetPx);
  const coarseCenters = coarseHandleGeometryReady
    ? pendingCoarseHandleCenters(
        start * zoomPxPerSec,
        end * zoomPxPerSec,
        timelineWidthPx,
        coarseTargetPx,
      )
    : null;
  const coarseHandles = coarseCenters !== null;
  const handleHalfWidth = coarseHandles ? coarseTargetPx / 2 : 0.25 * rootRem();
  const maxHandleCenter = Math.max(
    handleHalfWidth,
    timelineWidthPx - handleHalfWidth,
  );
  const clampHandleCenter = (edgeSec: number) =>
    Math.min(
      Math.max(edgeSec * zoomPxPerSec, handleHalfWidth),
      maxHandleCenter,
    );
  let startHandleCenter = coarseCenters?.start ?? clampHandleCenter(start);
  let endHandleCenter = coarseCenters?.end ?? clampHandleCenter(end);
  if (
    !coarseHandles &&
    endHandleCenter - startHandleCenter < 2 * handleHalfWidth
  ) {
    const middle = (startHandleCenter + endHandleCenter) / 2;
    startHandleCenter = middle - handleHalfWidth;
    endHandleCenter = middle + handleHalfWidth;
    if (startHandleCenter < handleHalfWidth) {
      const correction = handleHalfWidth - startHandleCenter;
      startHandleCenter += correction;
      endHandleCenter += correction;
    }
    if (endHandleCenter > maxHandleCenter) {
      const correction = endHandleCenter - maxHandleCenter;
      startHandleCenter -= correction;
      endHandleCenter -= correction;
    }
  }
  const startHandleOffset = startHandleCenter - start * zoomPxPerSec;
  const endHandleOffset = endHandleCenter - end * zoomPxPerSec;
  const regionOffset = regionCenter - hitCenter;
  const left = hitCenter;
  const width = hitWidth;
  const regionStyle: CSSProperties & {
    "--pending-region-width": string;
    "--pending-region-offset": string;
    "--pending-handle-start-offset": string;
    "--pending-handle-end-offset": string;
    "--pending-handle-half-width": string;
  } = {
    left,
    width,
    "--pending-region-width": `${visibleWidth}px`,
    "--pending-region-offset": `${regionOffset}px`,
    "--pending-handle-start-offset": `${startHandleOffset}px`,
    "--pending-handle-end-offset": `${endHandleOffset}px`,
    "--pending-handle-half-width": `${handleHalfWidth}px`,
  };
  const regionLabel = labelFor(edit);

  const cancelGesture = () => {
    if (currentGesture.current.kind !== "idle") {
      currentGesture.current.controller.abort();
    }
    currentGesture.current = IDLE;
    setGesture(IDLE);
  };
  const gestureIsCurrent = (capture: DragCapture) => {
    const active = currentGesture.current;
    return (
      active.kind === "settling" &&
      active.controller === capture.controller &&
      !capture.controller.signal.aborted &&
      useDawStore.getState().projectPath === capture.projectPath &&
      useDawStore.getState().projectEpoch === capture.projectEpoch
    );
  };
  const freshProjectAndEdit = (capture: DragCapture) => {
    const state = useDawStore.getState();
    const current = state.project?.pending_edits.find(
      (pending) => pending.id === capture.editId,
    );
    const currentPlacement =
      current &&
      current.source_start != null &&
      current.source_end != null &&
      !current.exact_range
        ? pendingEdgePlacement(
            clipsForOriginTrack(
              state.project?.clips.tracks ?? {},
              capture.trackId,
            ),
            capture.edge === "start"
              ? current.source_start
              : current.source_end,
            capture.edge === "start"
              ? (current.source_start_timeline ?? Number.NaN)
              : (current.source_end_timeline ?? Number.NaN),
          )
        : null;
    const samePlacement =
      currentPlacement?.kind === capture.placement.kind &&
      (currentPlacement.kind === "identity" ||
        (capture.placement.kind === "clip" &&
          currentPlacement.clip.id === capture.placement.clip.id &&
          currentPlacement.clip.source_id ===
            capture.placement.clip.source_id &&
          currentPlacement.clip.source_start ===
            capture.placement.clip.source_start &&
          currentPlacement.clip.source_end ===
            capture.placement.clip.source_end &&
          currentPlacement.clip.timeline_start ===
            capture.placement.clip.timeline_start &&
          currentPlacement.clip.timeline_end ===
            capture.placement.clip.timeline_end));
    return (
      state.projectPath === capture.projectPath &&
      state.projectEpoch === capture.projectEpoch &&
      canRetimePendingEdit(
        state.projectPath,
        state.shareCapabilities,
        state.shareAuthor,
        current?.author,
      ) &&
      current?.source_start === capture.sourceStart &&
      current.source_end === capture.sourceEnd &&
      current.track_id === capture.trackId &&
      samePlacement
    );
  };
  const focusRemainsInRegion = (relatedTarget: EventTarget | null) =>
    relatedTarget instanceof Node && regionRef.current?.contains(relatedTarget);

  useEffect(
    () =>
      useDawStore.subscribe((state) => {
        const active = currentGesture.current;
        if (
          active.kind !== "idle" &&
          (state.projectPath !== active.projectPath ||
            state.projectEpoch !== active.projectEpoch ||
            !freshProjectAndEdit(active))
        ) {
          active.controller.abort();
          currentGesture.current = IDLE;
          commitPendingRef.current = false;
          setGesture(IDLE);
        }
      }),
    [],
  );

  useEffect(() => {
    if (
      gesture.kind !== "idle" &&
      (gesture.projectPath !== projectPath ||
        gesture.projectEpoch !== projectEpoch)
    ) {
      cancelGesture();
    }
  }, [gesture, projectEpoch, projectPath]);

  useEffect(() => {
    if (wasSelected.current && !selected && gesture.kind !== "idle") {
      cancelGesture();
    }
    wasSelected.current = selected;
  }, [gesture.kind, selected]);

  const labelInPortal =
    width < LABEL_INLINE_WIDTH_REM * rootRem() &&
    (labelActive || (selected && !isOriginLane)) &&
    !(selected && isOriginLane && spanIndex === 0);
  useResizeObserver(
    [regionRef, actionbarRef],
    () => scheduleResizeUpdateRef.current?.(),
    selected || labelInPortal,
  );
  useEffect(() => {
    if ((!selected && !labelInPortal) || !regionRef.current) {
      return;
    }
    const update = () => {
      if (regionRef.current) {
        if (selected && actionbarRef.current) {
          const anchor = regionRef.current.getBoundingClientRect();
          setOverlayHeightPx(anchor.height);
          const panelElement = actionbarRef.current;
          const panel = panelElement.getBoundingClientRect();
          const panelStyle = window.getComputedStyle(panelElement);
          const naturalHeight =
            panelElement.scrollHeight +
            Number.parseFloat(panelStyle.borderTopWidth) +
            Number.parseFloat(panelStyle.borderBottomWidth);
          const rem = rootRem();
          const placement = placePendingActionbar(
            {
              left: anchor.left,
              top: anchor.top,
              bottom: anchor.bottom,
              width: anchor.width,
            },
            { width: panel.width, height: naturalHeight },
            { width: window.innerWidth, height: window.innerHeight },
            VIEWPORT_GUTTER_REM * rem,
          );
          setActionbarPlacement(placement);
          setPortalPosition(
            placement
              ? { left: placement.left, top: placement.top }
              : viewportPosition(regionRef.current),
          );
        } else {
          setActionbarPlacement(null);
          const bounds = regionRef.current.getBoundingClientRect();
          setOverlayHeightPx(bounds.height);
          setPortalPosition(viewportPosition(regionRef.current));
        }
        setPortalReady(true);
      }
    };
    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scheduleResizeUpdateRef.current = scheduleUpdate;
    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      scheduleResizeUpdateRef.current = null;
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [labelInPortal, selected, left, width]);

  useEffect(
    () => () => {
      if (currentGesture.current.kind !== "idle") {
        currentGesture.current.controller.abort();
      }
      currentGesture.current = IDLE;
    },
    [],
  );

  const beginDrag = (
    edge: PendingDragEdge,
    pointerId: number,
    clientX: number,
  ) => {
    const placement = edge === "start" ? startPlacement : endPlacement;
    if (
      !placement ||
      edit.exact_range ||
      edit.source_start == null ||
      edit.source_end == null ||
      !canAdjust ||
      commitPendingRef.current ||
      currentGesture.current.kind !== "idle"
    ) {
      return;
    }
    const next: Gesture = {
      kind: "dragging",
      pointerId,
      projectPath,
      projectEpoch: useDawStore.getState().projectEpoch,
      editId: edit.id,
      trackId: edit.track_id,
      sourceStart: edit.source_start,
      sourceEnd: edit.source_end,
      edge,
      originX: clientX,
      placement,
      controller: new AbortController(),
      sourceDeltaSec: 0,
    };
    currentGesture.current = next;
    setGesture(next);
    onSelect(edit.id);
  };

  const moveDrag = (pointerId: number, clientX: number) => {
    const active = currentGesture.current;
    if (active.kind !== "dragging" || active.pointerId !== pointerId) {
      return;
    }
    const next = {
      ...active,
      sourceDeltaSec: (clientX - active.originX) / zoomPxPerSec,
    };
    currentGesture.current = next;
    setGesture(next);
  };

  const finishDrag = async (pointerId: number, clientX: number) => {
    const active = currentGesture.current;
    if (active.kind !== "dragging" || active.pointerId !== pointerId) {
      return;
    }
    const sourceDeltaSec = (clientX - active.originX) / zoomPxPerSec;
    const preview = pendingEdgePreview({
      edge: active.edge,
      sourceStart: active.sourceStart,
      sourceEnd: active.sourceEnd,
      sourceDeltaSec,
      placement: active.placement,
      ticks: [],
      zoomPxPerSec,
    });
    if (
      !preview ||
      !isHandleDrag(active.originX, clientX) ||
      (preview.sourceStart === active.sourceStart &&
        preview.sourceEnd === active.sourceEnd)
    ) {
      cancelGesture();
      return;
    }
    if (
      active.projectPath !== projectPath ||
      active.projectEpoch !== useDawStore.getState().projectEpoch ||
      !freshProjectAndEdit(active)
    ) {
      cancelGesture();
      return;
    }
    const settling: Gesture = {
      ...active,
      kind: "settling",
      sourceDeltaSec,
      preview,
    };
    currentGesture.current = settling;
    setGesture(settling);
    commitPendingRef.current = true;
    let resolvingSnapTicks = true;
    try {
      const focusSec =
        active.edge === "start" ? preview.sourceStart : preview.sourceEnd;
      const resolvedTicks = await snapResource.resolveTicks(
        focusSec,
        active.controller.signal,
      );
      if (!gestureIsCurrent(active) || !freshProjectAndEdit(active)) {
        return;
      }
      const resolvedPreview = pendingEdgePreview({
        edge: active.edge,
        sourceStart: active.sourceStart,
        sourceEnd: active.sourceEnd,
        sourceDeltaSec,
        placement: active.placement,
        ticks: resolvedTicks,
        zoomPxPerSec,
      });
      if (
        !resolvedPreview ||
        (resolvedPreview.sourceStart === active.sourceStart &&
          resolvedPreview.sourceEnd === active.sourceEnd)
      ) {
        cancelGesture();
        return;
      }
      const committedGesture: Gesture = {
        ...settling,
        preview: resolvedPreview,
      };
      currentGesture.current = committedGesture;
      setGesture(committedGesture);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (!gestureIsCurrent(active) || !freshProjectAndEdit(active)) {
        return;
      }
      resolvingSnapTicks = false;
      await onCommitSpan(
        active.projectPath,
        active.projectEpoch,
        active.editId,
        active.sourceStart,
        active.sourceEnd,
        resolvedPreview.sourceStart,
        resolvedPreview.sourceEnd,
      );
    } catch (error) {
      if (
        !active.controller.signal.aborted &&
        gestureIsCurrent(active) &&
        freshProjectAndEdit(active)
      ) {
        setActionState({
          kind: "error",
          message: resolvingSnapTicks
            ? "Nearby waveform snap points could not be loaded. Try again."
            : errorMessage(error),
          code:
            !resolvingSnapTicks && error instanceof ApiError
              ? error.code
              : null,
        });
      }
    } finally {
      commitPendingRef.current = false;
      const current = currentGesture.current;
      if (
        current.kind === "settling" &&
        current.controller === active.controller
      ) {
        currentGesture.current = IDLE;
        setGesture(IDLE);
      }
    }
  };

  const focusTimingField = () => {
    const initial = useDawStore.getState();
    const initialEpoch = initial.projectEpoch;
    if (
      !canAdjust ||
      isSplit ||
      initial.projectPath !== projectPath ||
      initial.selection?.kind !== "pending" ||
      initial.selection.id !== edit.id
    ) {
      return;
    }
    requestAnimationFrame(() => {
      const state = useDawStore.getState();
      if (
        state.projectPath !== projectPath ||
        state.projectEpoch !== initialEpoch ||
        state.selection?.kind !== "pending" ||
        state.selection.id !== edit.id ||
        !canRetimePendingEdit(
          state.projectPath,
          state.shareCapabilities,
          state.shareAuthor,
          edit.author,
        )
      ) {
        return;
      }
      const field = document.getElementById(
        pendingEditTimingFieldId(edit.id, "start"),
      );
      if (field instanceof HTMLInputElement) {
        field.scrollIntoView({ block: "center" });
        field.focus();
      }
    });
  };

  const runReviewAction = async (action: ReviewAction) => {
    const before = useDawStore.getState();
    const projectEpoch = before.projectEpoch;
    const selectionMatches = () => {
      const current = useDawStore.getState();
      return (
        current.projectPath === projectPath &&
        current.projectEpoch === projectEpoch &&
        current.selection?.kind === "pending" &&
        current.selection.id === edit.id
      );
    };
    if (!selectionMatches() || commitPendingRef.current) {
      return;
    }
    setQueued(false);
    setActionState({ kind: "busy", action });
    try {
      const result = await onReviewAction(
        projectPath,
        projectEpoch,
        edit.id,
        action,
      );
      if (!selectionMatches()) {
        return;
      }
      setQueued(result.queued);
      setActionState({ kind: "idle" });
    } catch (error) {
      if (selectionMatches()) {
        setActionState({
          kind: "error",
          message: errorMessage(error),
          code: error instanceof ApiError ? error.code : null,
        });
      }
    }
  };

  const buttonFor = (edge: PendingDragEdge, available: boolean) =>
    available ? (
      <button
        type="button"
        className={`pending-handle ${edge}`}
        {...hitTargetProps(
          edge === "start" ? "pending-start" : "pending-end",
          edit.id,
          edge === "start" ? start : end,
          { selected, detail: edit.type },
        )}
        aria-label={`Adjust pending ${edit.type} ${edge} edge`}
        aria-describedby={edgeHintId}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(edit.id);
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            return;
          }
          beginDrag(edge, event.pointerId, event.clientX);
        }}
        onPointerMove={(event) => moveDrag(event.pointerId, event.clientX)}
        onPointerUp={(event) => void finishDrag(event.pointerId, event.clientX)}
        onPointerCancel={(event) => {
          if (
            currentGesture.current.kind === "dragging" &&
            currentGesture.current.pointerId === event.pointerId
          ) {
            cancelGesture();
          }
        }}
        onLostPointerCapture={(event) => {
          if (
            currentGesture.current.kind === "dragging" &&
            currentGesture.current.pointerId === event.pointerId
          ) {
            cancelGesture();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancelGesture();
          }
        }}
      />
    ) : null;

  const visibleLabel =
    width >= LABEL_INLINE_WIDTH_REM * rootRem() ? (
      <span className="pending-label" aria-hidden="true">
        {regionLabel}
      </span>
    ) : null;
  const portaledLabel =
    labelInPortal && portalReady && typeof document !== "undefined"
      ? createPortal(
          <span
            className="pending-label pending-label--floating"
            style={{ left: portalPosition.left, top: portalPosition.top }}
            aria-hidden="true"
          >
            {regionLabel}
          </span>,
          document.body,
        )
      : null;
  const actionbarStyle: CSSProperties & {
    "--pending-actionbar-max-height": string;
  } = {
    left: portalReady && actionbarPlacement ? actionbarPlacement.left : -10000,
    top: portalReady && actionbarPlacement ? actionbarPlacement.top : 0,
    visibility: portalReady && actionbarPlacement ? "visible" : "hidden",
    "--pending-actionbar-max-height": `${actionbarPlacement?.maxHeight ?? 0}px`,
  };
  const actionPortal =
    selected &&
    isOriginLane &&
    spanIndex === 0 &&
    typeof document !== "undefined"
      ? createPortal(
          <div
            ref={actionbarRef}
            className="pending-actionbar"
            style={actionbarStyle}
            aria-hidden={!portalReady || actionbarPlacement === null}
            role="region"
            aria-label="Pending edit actions"
            data-coarse-pointer={coarsePointer ? "true" : undefined}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {width < LABEL_INLINE_WIDTH_REM * rootRem() ? (
              <span className="pending-label">{regionLabel}</span>
            ) : null}
            {canAdjust && !isSplit ? (
              <Button
                className="pending-timing-action"
                onClick={focusTimingField}
              >
                Edit timing
              </Button>
            ) : null}
            {canApply || edit.exact_range ? (
              <div className="pending-actions">
                <Button
                  variant="primary"
                  disabled={
                    !canApply ||
                    actionState.kind === "busy" ||
                    gesture.kind === "settling"
                  }
                  title={
                    !canApply
                      ? "Only the host or an edit guest can review exact range proposals"
                      : undefined
                  }
                  onClick={() => void runReviewAction("approve")}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={
                    !canApply ||
                    actionState.kind === "busy" ||
                    gesture.kind === "settling"
                  }
                  title={
                    !canApply
                      ? "Only the host or an edit guest can review exact range proposals"
                      : undefined
                  }
                  onClick={() => void runReviewAction("reject")}
                >
                  Reject
                </Button>
              </div>
            ) : null}
            {edit.exact_range && !canApply ? (
              <p className="ui-field-hint">
                Only the host or an edit guest can review exact range proposals.
              </p>
            ) : null}
            {actionState.kind === "busy" ? (
              <span role="status">
                {actionState.action === "approve" ? "Approving…" : "Rejecting…"}
              </span>
            ) : null}
            {gesture.kind === "settling" ? (
              <span role="status">Checking nearby snap points…</span>
            ) : null}
            {queuedNotice}
            {actionState.kind === "error" &&
            actionState.code === TRANSCRIPT_REFINE_REQUIRED_CODE ? (
              <>
                <p role="alert">{REFINE_GATE_GUI_MESSAGE}</p>
              </>
            ) : null}
            {!isShareProjectKey(projectPath) ? (
              <TranscriptRefineRecovery
                key={`${projectPath}:${edit.id}`}
                projectPath={projectPath}
                error={
                  actionState.kind === "error" ? actionState.message : null
                }
                errorCode={
                  actionState.kind === "error" ? actionState.code : null
                }
                onRecovered={() => {
                  const state = useDawStore.getState();
                  if (
                    state.projectPath === projectPath &&
                    state.projectEpoch === projectEpoch &&
                    state.selection?.kind === "pending" &&
                    state.selection.id === edit.id
                  ) {
                    setActionState({ kind: "idle" });
                  }
                }}
              />
            ) : null}
            {actionState.kind === "error" &&
            actionState.code !== TRANSCRIPT_REFINE_REQUIRED_CODE ? (
              <span role="alert">{actionState.message}</span>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div
        ref={regionRef}
        className={`pending-overlay${edit.type === "mute" ? " mute" : isSplit ? " split" : " remove"}${selected ? " selected" : ""}`}
        data-pending-id={edit.id}
        style={regionStyle}
        data-coarse-handles={coarseHandles ? "ready" : undefined}
        data-coarse-pointer={coarsePointer ? "true" : undefined}
        title={`${pendingReasonLabel(edit.reason)}`}
        onPointerEnter={() => setLabelActive(true)}
        onPointerLeave={() =>
          setLabelActive(
            Boolean(regionRef.current?.contains(document.activeElement)),
          )
        }
        onFocusCapture={() => setLabelActive(true)}
        onBlurCapture={(event) => {
          if (!focusRemainsInRegion(event.relatedTarget)) {
            setLabelActive(false);
          }
        }}
      >
        <button
          type="button"
          className="pending-hit"
          {...(isSplit
            ? hitTargetProps("pending-flag", edit.id, start, {
                selected,
                detail: edit.type,
              })
            : HIT_SURFACE_PROPS)}
          aria-label={`Pending ${edit.type} edit, ${regionLabel}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(edit.id);
          }}
        />
        <span id={edgeHintId} className="sr-only">
          Drag to adjust. Press Enter or Space to open the inspector and use
          Source start or Source end for keyboard adjustment.
        </span>
        {visibleLabel}
        {buttonFor("start", canDragStart)}
        {buttonFor("end", canDragEnd)}
      </div>
      {portaledLabel}
      {actionPortal}
    </>
  );
}

export function PendingEditOverlayView({
  edits,
  trackId,
  zoomPxPerSec,
  selectedId,
  projectPath,
  timelineWidthPx,
  clipsByTrack,
  canAdjust,
  canApply,
  onSelect,
  onCommitSpan,
  onReviewAction,
}: PendingEditOverlayViewProps) {
  const projectEpoch = useDawStore((state) => state.projectEpoch);
  const shareCapabilities = useDawStore((state) => state.shareCapabilities);
  const shareAuthor = useDawStore((state) => state.shareAuthor);
  return (
    <>
      {edits
        .filter(
          (edit) =>
            pendingEditTrackIds(edit).includes(trackId) && edit.mappable,
        )
        .flatMap((edit) =>
          edit.timeline_spans.map((span, spanIndex) => (
            <PendingEditRegion
              key={`${projectPath}:${projectEpoch}:${edit.id}-${spanIndex}`}
              edit={edit}
              span={span}
              spanIndex={spanIndex}
              trackId={trackId}
              zoomPxPerSec={zoomPxPerSec}
              selected={selectedId === edit.id}
              projectPath={projectPath}
              timelineWidthPx={timelineWidthPx}
              clipsByTrack={clipsByTrack}
              canAdjust={
                canAdjust &&
                canRetimePendingEdit(
                  projectPath,
                  shareCapabilities,
                  shareAuthor,
                  edit.author,
                ) &&
                !edit.exact_range &&
                edit.source_start != null &&
                edit.source_end != null
              }
              canApply={canApply}
              onSelect={onSelect}
              onCommitSpan={onCommitSpan}
              onReviewAction={onReviewAction}
            />
          )),
        )}
    </>
  );
}
