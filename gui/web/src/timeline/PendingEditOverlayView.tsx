import type { CSSProperties } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isHandleDrag } from "../edit/dragThreshold";
import { useWaveformSnapTicks } from "../hooks/useWaveformSnapTicks";
import { canRetimePendingEdit } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow, PendingEditView } from "../types/project";
import { useResizeObserver } from "../ui/useResizeObserver";
import { errorMessage } from "../utils/apiError";
import { markerVariant, pendingKind } from "../utils/editMarkerRegistry";
import { pendingEditTrackIds } from "../utils/edits";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../utils/pendingEditLabels";
import { formatTimeMs } from "../utils/time";
import { clipsForOriginTrack } from "../utils/timebase";
import { hitTargetProps, OWN_TAP_HIT_SURFACE_PROPS } from "./hitTargets";
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
import { snapActive } from "./snapOverlay";

export interface PendingEditOverlayViewProps {
  edits: readonly PendingEditView[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
  projectPath: string;
  timelineWidthPx: number;
  clipsByTrack: Record<string, ClipRow[]>;
  canAdjust: boolean;
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
  snap: boolean;
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
const VIEWPORT_GUTTER_REM = 0.5;
const FLOATING_LABEL_WIDTH_REM = 15;
const LABEL_INLINE_WIDTH_REM = 9;

function rootRem(): number {
  return (
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  );
}

/**
 * The chrome that bounds where the card may float. Its size changes without a
 * scroll or resize (a comment grows the marker lane; the Player grows to its
 * expanded form), so the overlay observes each one.
 */
const FLOAT_BOUNDS_SELECTORS = [".marker-lane", ".stage-frame-player"];
const floatBounds = FLOAT_BOUNDS_SELECTORS.map(
  (selector) => () => document.querySelector(selector),
);

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

/** Where the card may reach on the inline end: the viewport, or the Inspector column's edge (#1696). */
function floatRight(): number {
  return (
    document.querySelector(".bottom-sheet--column")?.getBoundingClientRect()
      .left ?? window.innerWidth
  );
}

function viewportPosition(anchor: HTMLElement): { left: number; top: number } {
  const bounds = anchor.getBoundingClientRect();
  const rem = rootRem();
  const gutter = VIEWPORT_GUTTER_REM * rem;
  const width = FLOATING_LABEL_WIDTH_REM * rem;
  const left = Math.min(
    Math.max(gutter, bounds.left),
    Math.max(gutter, floatRight() - width - gutter),
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
  onSelect,
  onCommitSpan,
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
  onSelect: (id: string) => void;
  onCommitSpan: PendingEditOverlayViewProps["onCommitSpan"];
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const scheduleResizeUpdateRef = useRef<(() => void) | null>(null);
  const currentGesture = useRef<Gesture>(IDLE);
  const commitPendingRef = useRef(false);
  const wasSelected = useRef(selected);
  const [gesture, setGesture] = useState<Gesture>(IDLE);
  const [portalPosition, setPortalPosition] = useState({ left: 0, top: 0 });
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
    gesture.kind !== "idle" && canAdjust && gesture.snap,
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
            ticks: gesture.snap ? ticks : [],
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
    (labelActive || (selected && !isOriginLane));
  useResizeObserver(
    [regionRef, ...floatBounds],
    () => scheduleResizeUpdateRef.current?.(),
    selected || labelInPortal,
  );
  useEffect(() => {
    if ((!selected && !labelInPortal) || !regionRef.current) {
      return;
    }
    let frame = 0;
    const update = () => {
      if (regionRef.current) {
        setOverlayHeightPx(regionRef.current.getBoundingClientRect().height);
        setPortalPosition(viewportPosition(regionRef.current));
        setPortalReady(true);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scheduleResizeUpdateRef.current = schedule;
    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      scheduleResizeUpdateRef.current = null;
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
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
    altKey: boolean,
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
      snap: snapActive(useDawStore.getState().snapEnabled, altKey),
      placement,
      controller: new AbortController(),
      sourceDeltaSec: 0,
    };
    currentGesture.current = next;
    setGesture(next);
    onSelect(edit.id);
  };

  const moveDrag = (pointerId: number, clientX: number, altKey: boolean) => {
    const active = currentGesture.current;
    if (active.kind !== "dragging" || active.pointerId !== pointerId) {
      return;
    }
    const next = {
      ...active,
      sourceDeltaSec: (clientX - active.originX) / zoomPxPerSec,
      snap: snapActive(useDawStore.getState().snapEnabled, altKey),
    };
    currentGesture.current = next;
    setGesture(next);
  };

  const finishDrag = async (
    pointerId: number,
    clientX: number,
    altKey: boolean,
  ) => {
    const active = currentGesture.current;
    if (active.kind !== "dragging" || active.pointerId !== pointerId) {
      return;
    }
    const sourceDeltaSec = (clientX - active.originX) / zoomPxPerSec;
    const snap = snapActive(useDawStore.getState().snapEnabled, altKey);
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
      snap,
      kind: "settling",
      sourceDeltaSec,
      preview,
    };
    currentGesture.current = settling;
    setGesture(settling);
    commitPendingRef.current = true;
    // The Action bar's Cut and Keep read this: they must not decide the bounds being replaced.
    useDawStore.getState().setPendingRetimeInFlight(active.editId);
    let resolvingSnapTicks = true;
    try {
      const focusSec =
        active.edge === "start" ? preview.sourceStart : preview.sourceEnd;
      const resolvedTicks = snap
        ? await snapResource.resolveTicks(focusSec, active.controller.signal)
        : [];
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
        const message = resolvingSnapTicks
          ? "Nearby waveform snap points could not be loaded. Try again."
          : errorMessage(error);
        useDawStore.getState().announceStatus(message, { tone: "error" });
      }
    } finally {
      commitPendingRef.current = false;
      const live = useDawStore.getState();
      if (live.pendingRetimeInFlight === active.editId)
        live.setPendingRetimeInFlight(null);
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
          beginDrag(edge, event.pointerId, event.clientX, event.altKey);
        }}
        onPointerMove={(event) =>
          moveDrag(event.pointerId, event.clientX, event.altKey)
        }
        onPointerUp={(event) =>
          void finishDrag(event.pointerId, event.clientX, event.altKey)
        }
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
  return (
    <>
      <div
        ref={regionRef}
        className={`pending-overlay ${markerVariant(pendingKind(edit.type))}${selected ? " selected" : ""}`}
        data-pending-id={edit.id}
        style={regionStyle}
        data-coarse-handles={coarseHandles ? "ready" : undefined}
        data-coarse-pointer={coarsePointer ? "true" : undefined}
        title={`${pendingReasonLabel(edit.reason, edit.kind)}`}
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
            : OWN_TAP_HIT_SURFACE_PROPS)}
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
  onSelect,
  onCommitSpan,
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
              onSelect={onSelect}
              onCommitSpan={onCommitSpan}
            />
          )),
        )}
    </>
  );
}
