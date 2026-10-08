import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  BoundaryEdit,
  BoundaryGeometryClip,
  BoundaryTarget,
} from "../api/boundary";
import { loadBoundaryContext } from "../api/boundary";
import { capabilityTooltip } from "../capabilities/copy";
import {
  clampRollDelta,
  clampTrimSourceSec,
  type RollNeighborBounds,
  sourceSecFromTimelineDelta,
  type TrimEdge,
} from "../edit/clipEdgePreview";
import {
  expandGhostSourceRange,
  ghostPlacementForExpand,
  ghostWordsForExpandPreview,
} from "../edit/ghostPreview";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/hostSendOrder";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { GhostWordChips } from "./GhostWordChips";
import { PrecisionBoundaryDialog } from "./PrecisionBoundaryDialog";
import { TRANSCRIPT_EDIT_BOUNDARY_TIP } from "./transcriptModeCopy";

export interface EditBoundaryMarkViewProps {
  projectPath?: string;
  boundary: EditBoundaryView;
  leftClip: ClipRow | null;
  rightClip: ClipRow | null;
  /** Roll clamp neighbours (`rollNeighborBounds`), read when a roll drag starts. */
  getRollBounds: () => RollNeighborBounds;
  onRoll: (
    leftClipId: string,
    rightClipId: string,
    deltaSec: number,
    expectedToken: string,
  ) => Promise<void | { queued: boolean }> | void | { queued: boolean };
  onTrim: (
    clipId: string,
    edge: TrimEdge,
    sourceSec: number,
    mode: "ripple",
    expectedToken: string,
  ) => Promise<void | { queued: boolean }> | void | { queued: boolean };
  target?: BoundaryTarget;
  expectedGeometry?: BoundaryGeometryClip[];
  canEdit?: boolean;
  canOpenPrecision?: boolean;
}

type TrimDragState = {
  kind: "trim";
  originX: number;
  edge: "in" | "out";
  clipId: string;
  baseSourceSec: number;
  sourceStart: number;
  sourceEnd: number;
  neighborLo: number;
  neighborHi: number;
  pointerId: number;
};

type RollDragState = {
  kind: "roll";
  originX: number;
  leftClipId: string;
  rightClipId: string;
  leftSourceStart: number;
  leftSourceEnd: number;
  rightSourceStart: number;
  rightSourceEnd: number;
  prevSourceEnd: number;
  nextSourceStart: number;
  mediaEnd: number;
  pointerId: number;
};

type DragState = TrimDragState | RollDragState;

/** Transcript-density heuristic: px → seconds for boundary drag. */
export const BOUNDARY_PX_PER_SEC = 80;
export const BOUNDARY_DRAG_THRESHOLD_PX = 6;
export const BOUNDARY_FINE_DRAG_SCALE = 12.5;

const DRAG_CLASS = "is-boundary-dragging";

type Gesture = {
  drag: DragState;
  boundary: EditBoundaryView;
  target: BoundaryTarget;
  expectedGeometry: BoundaryGeometryClip[];
  projectPath: string;
  projectEpoch: number;
  lastClientX: number;
  deltaSec: number;
  rect: DOMRect;
  rootRem: number;
  previewGapPx: number;
};

type Lifecycle =
  | { kind: "idle" }
  | {
      kind: "dragging";
      gesture: Gesture;
      deltaSec: number;
      visualDeltaPx: number;
      fine: boolean;
      limited: boolean;
    }
  | { kind: "pending"; gesture: Gesture }
  | { kind: "error"; gesture: Gesture; message: string };

function deltaForDrag(drag: DragState, clientX: number) {
  const proposed = (clientX - drag.originX) / BOUNDARY_PX_PER_SEC;
  if (drag.kind === "roll") return clampRollDelta(proposed, drag);
  return (
    clampTrimSourceSec(
      drag.edge,
      sourceSecFromTimelineDelta(drag.baseSourceSec, proposed),
      drag.sourceStart,
      drag.sourceEnd,
      drag.neighborLo,
      drag.neighborHi,
    ) - drag.baseSourceSec
  );
}

function advanceGesture(
  gesture: Gesture,
  clientX: number,
  fine: boolean,
): {
  deltaSec: number;
  visualDeltaPx: number;
  fine: boolean;
  limited: boolean;
} {
  const { drag } = gesture;
  const scale = BOUNDARY_PX_PER_SEC * (fine ? BOUNDARY_FINE_DRAG_SCALE : 1);
  const proposed = gesture.deltaSec + (clientX - gesture.lastClientX) / scale;
  const minimum = deltaForDrag(drag, drag.originX - 1e9);
  const maximum = deltaForDrag(drag, drag.originX + 1e9);
  const minAllowed = Math.min(minimum, maximum);
  const maxAllowed = Math.max(minimum, maximum);
  const deltaSec = Math.max(minAllowed, Math.min(maxAllowed, proposed));
  const visualDeltaPx = clientX - drag.originX;
  gesture.lastClientX = clientX;
  gesture.deltaSec = deltaSec;
  return {
    deltaSec,
    visualDeltaPx,
    fine,
    limited: Math.abs(deltaSec - proposed) > 1e-9,
  };
}

export function EditBoundaryMarkView({
  projectPath: projectPathProp,
  boundary,
  leftClip,
  rightClip,
  getRollBounds,
  onRoll,
  onTrim,
  target,
  expectedGeometry = [],
  canEdit = true,
  canOpenPrecision = canEdit,
}: EditBoundaryMarkViewProps) {
  const storeProjectPath = useDawStore((s) => s.projectPath);
  const projectPath =
    projectPathProp ?? (storeProjectPath || "/tmp/story-project");
  const markRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef<Gesture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [lifecycle, setLifecycle] = useState<Lifecycle>({ kind: "idle" });
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const fallbackClip = leftClip ?? rightClip;
  const resolvedTarget =
    target ??
    (leftClip && rightClip
      ? {
          kind: "roll" as const,
          left_clip_id: leftClip.id,
          right_clip_id: rightClip.id,
        }
      : fallbackClip
        ? {
            kind: "trim" as const,
            clip_id: fallbackClip.id,
            edge: leftClip ? ("out" as const) : ("in" as const),
          }
        : null);
  const resolvedGeometry =
    expectedGeometry.length > 0
      ? expectedGeometry
      : [leftClip, rightClip]
          .filter((clip): clip is ClipRow => clip !== null)
          .map(
            ({ id, source_start, source_end, timeline_start, source_id }) => ({
              id,
              source_start,
              source_end,
              timeline_start,
              source_id,
            }),
          );
  const dragging = lifecycle.kind === "dragging";
  const tip =
    leftClip && rightClip
      ? capabilityTooltip("daw.edit.rollClipJoin")
      : TRANSCRIPT_EDIT_BOUNDARY_TIP;

  const applyBoundary = async (
    edit: BoundaryEdit,
    expectedToken: string,
  ): Promise<{ queued: boolean }> => {
    if (edit.kind === "roll")
      return (
        (await onRoll(
          edit.left_clip_id,
          edit.right_clip_id,
          edit.delta_sec,
          expectedToken,
        )) ?? { queued: false }
      );
    return (
      (await onTrim(
        edit.clip_id,
        edit.edge,
        edit.source_sec,
        edit.mode,
        expectedToken,
      )) ?? { queued: false }
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupRef.current?.();
    };
  }, []);

  const cancel = () => {
    if (!activeRef.current) return;
    cleanupRef.current?.();
    setLifecycle({ kind: "idle" });
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (
      !canEdit ||
      (event.button != null && event.button !== 0) ||
      activeRef.current ||
      pendingRef.current ||
      document.body.classList.contains(DRAG_CLASS)
    )
      return;
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    let drag: DragState;
    if (leftClip && rightClip) {
      drag = {
        kind: "roll",
        originX: event.clientX,
        pointerId,
        leftClipId: leftClip.id,
        rightClipId: rightClip.id,
        leftSourceStart: leftClip.source_start,
        leftSourceEnd: leftClip.source_end,
        rightSourceStart: rightClip.source_start,
        rightSourceEnd: rightClip.source_end,
        ...getRollBounds(),
      };
    } else {
      const clip = leftClip ?? rightClip;
      if (!clip) return;
      drag = {
        kind: "trim",
        originX: event.clientX,
        pointerId,
        edge: leftClip ? "out" : "in",
        clipId: clip.id,
        baseSourceSec: leftClip ? clip.source_end : clip.source_start,
        sourceStart: clip.source_start,
        sourceEnd: clip.source_end,
        neighborLo: 0,
        neighborHi: Number.POSITIVE_INFINITY,
      };
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const project = useDawStore.getState();
    const rootRem = Number.parseFloat(rootStyle.fontSize) || 16;
    const gapRem =
      Number.parseFloat(getComputedStyle(el).getPropertyValue("--space-3")) ||
      0.5;
    const gesture: Gesture = {
      drag,
      boundary: {
        ...boundary,
        cutaway_word_ids: [...boundary.cutaway_word_ids],
      },
      target:
        resolvedTarget ??
        (drag.kind === "roll"
          ? {
              kind: "roll",
              left_clip_id: drag.leftClipId,
              right_clip_id: drag.rightClipId,
            }
          : { kind: "trim", clip_id: drag.clipId, edge: drag.edge }),
      expectedGeometry: resolvedGeometry.map((clip) => ({ ...clip })),
      projectPath,
      projectEpoch: project.projectEpoch,
      lastClientX: drag.originX,
      deltaSec: 0,
      rect: el.getBoundingClientRect(),
      rootRem,
      previewGapPx: gapRem * rootRem,
    };
    const transcript = el.closest(".transcript-list");
    let dragStarted = false;
    activeRef.current = gesture;
    try {
      el.setPointerCapture(pointerId);
    } catch {}

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || activeRef.current !== gesture) return;
      if (
        !dragStarted &&
        Math.abs(ev.clientX - drag.originX) < BOUNDARY_DRAG_THRESHOLD_PX
      )
        return;
      if (!dragStarted) {
        dragStarted = true;
        document.body.classList.add(DRAG_CLASS);
        transcript?.classList.add(DRAG_CLASS);
        el.focus({ preventScroll: true });
      }
      ev.preventDefault();
      const update = advanceGesture(gesture, ev.clientX, ev.shiftKey);
      setLifecycle({
        kind: "dragging",
        gesture,
        ...update,
      });
    };
    const onCancel = () => cancel();
    const onPointerCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) cancel();
    };
    const onScroll = (event: Event) => {
      if (
        event.target === window ||
        event.target === document ||
        (event.target instanceof Element && event.target.contains(el))
      )
        cancel();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || activeRef.current !== gesture) return;
      if (
        !dragStarted &&
        Math.abs(ev.clientX - drag.originX) >= BOUNDARY_DRAG_THRESHOLD_PX
      )
        dragStarted = true;
      if (!dragStarted) {
        cleanup();
        setLifecycle({ kind: "idle" });
        return;
      }
      const { deltaSec } = advanceGesture(gesture, ev.clientX, ev.shiftKey);
      suppressClickRef.current = true;
      cleanup();
      if (Math.abs(deltaSec) < 1e-3) {
        setLifecycle({ kind: "idle" });
        return;
      }
      pendingRef.current = true;
      setLifecycle({ kind: "pending", gesture });
      const save = (async () => {
        try {
          const beforeRequest = useDawStore.getState();
          if (
            beforeRequest.projectPath !== gesture.projectPath ||
            beforeRequest.projectEpoch !== gesture.projectEpoch
          )
            throw new Error("Project changed during the boundary drag");
          const context = await loadBoundaryContext(
            gesture.projectPath,
            gesture.target,
            gesture.expectedGeometry,
          );
          const project = useDawStore.getState();
          if (
            project.projectPath !== gesture.projectPath ||
            project.projectEpoch !== gesture.projectEpoch
          )
            throw new Error("Project changed during the boundary drag");
          if (drag.kind === "roll") {
            await onRoll(
              drag.leftClipId,
              drag.rightClipId,
              deltaSec,
              context.token,
            );
          } else {
            await onTrim(
              drag.clipId,
              drag.edge,
              drag.baseSourceSec + deltaSec,
              "ripple",
              context.token,
            );
          }
          if (mountedRef.current) setLifecycle({ kind: "idle" });
        } catch (error) {
          if (mountedRef.current)
            setLifecycle({
              kind: "error",
              gesture,
              message: `Could not save boundary edit. ${error instanceof Error ? error.message : "Try dragging again."}`,
            });
        } finally {
          pendingRef.current = false;
        }
      })();
      void trackEditSave(gesture.projectPath, save);
    };
    const cleanup = () => {
      if (activeRef.current !== gesture) return;
      activeRef.current = null;
      cleanupRef.current = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("resize", onCancel);
      window.removeEventListener("scroll", onScroll, true);
      el.removeEventListener("lostpointercapture", onPointerCancel);
      if (dragStarted) {
        document.body.classList.remove(DRAG_CLASS);
        transcript?.classList.remove(DRAG_CLASS);
      }
      try {
        if (el.hasPointerCapture(pointerId))
          el.releasePointerCapture(pointerId);
      } catch {
        /* Capture may already be lost. */
      }
    };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("blur", onCancel);
    window.addEventListener("resize", onCancel);
    window.addEventListener("scroll", onScroll, true);
    el.addEventListener("lostpointercapture", onPointerCancel);
  };

  const feedback =
    lifecycle.kind === "idle"
      ? null
      : (() => {
          const { gesture } = lifecycle;
          const { drag, rect, rootRem } = gesture;
          const gutter = rootRem;
          const width = Math.max(
            0,
            Math.min(20 * rootRem, window.innerWidth - 2 * gutter),
          );
          const left = Math.max(
            gutter,
            Math.min(rect.left, window.innerWidth - width - gutter),
          );
          const gap = gesture.previewGapPx;
          const viewportTop = gutter;
          const viewportBottom = Math.max(
            viewportTop,
            window.innerHeight - gutter,
          );
          const aboveEdge = Math.max(
            viewportTop,
            Math.min(rect.top - gap, viewportBottom),
          );
          const belowEdge = Math.max(
            viewportTop,
            Math.min(rect.bottom + gap, viewportBottom),
          );
          const aboveRoom = aboveEdge - viewportTop;
          const belowRoom = viewportBottom - belowEdge;
          const above = aboveRoom > belowRoom;
          const maxHeight = above ? aboveRoom : belowRoom;
          const position = above
            ? { bottom: `${(window.innerHeight - aboveEdge) / rootRem}rem` }
            : { top: `${belowEdge / rootRem}rem` };
          const words =
            lifecycle.kind === "dragging"
              ? ghostWordsForExpandPreview(
                  gesture.boundary.cutaway_word_ids,
                  expandGhostSourceRange({
                    kind: drag.kind,
                    deltaSec: lifecycle.deltaSec,
                    edge: drag.kind === "trim" ? drag.edge : undefined,
                    leftSourceEnd:
                      drag.kind === "roll"
                        ? drag.leftSourceEnd
                        : drag.edge === "out"
                          ? drag.baseSourceSec
                          : gesture.boundary.cutaway_source_start,
                    rightSourceStart:
                      drag.kind === "roll"
                        ? drag.rightSourceStart
                        : drag.edge === "in"
                          ? drag.baseSourceSec
                          : gesture.boundary.cutaway_source_end,
                  }),
                )
              : [];
          const side =
            lifecycle.kind === "dragging"
              ? ghostPlacementForExpand({
                  kind: drag.kind,
                  deltaSec: lifecycle.deltaSec,
                  edge: drag.kind === "trim" ? drag.edge : undefined,
                })
              : null;
          const visibleWords = words.slice(0, 6).map((word) => ({
            ...word,
            text:
              word.text.length > 24 ? `${word.text.slice(0, 24)}…` : word.text,
          }));
          const abbreviated = visibleWords.some(
            (word, index) => word.text !== words[index]?.text,
          );
          return createPortal(
            <section
              className={`edit-boundary-preview${lifecycle.kind === "error" ? " edit-boundary-preview-error" : ""}`}
              aria-label={
                lifecycle.kind === "error"
                  ? "Boundary edit feedback"
                  : undefined
              }
              style={{
                ...position,
                left: `${left / rootRem}rem`,
                width: `${width / rootRem}rem`,
                maxHeight: `${maxHeight / rootRem}rem`,
              }}
            >
              {lifecycle.kind === "error" ? (
                <>
                  <div className="edit-boundary-error-header">
                    <span>Boundary edit failed</span>
                    <button
                      type="button"
                      onClick={() => {
                        setLifecycle({ kind: "idle" });
                        markRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      Dismiss boundary error
                    </button>
                  </div>
                  <div
                    role="alert"
                    tabIndex={0}
                    className="edit-boundary-error-body"
                  >
                    {lifecycle.message}
                  </div>
                </>
              ) : (
                <span role="status" className="edit-boundary-delta">
                  {lifecycle.kind === "pending"
                    ? "Saving boundary edit…"
                    : `${drag.kind === "roll" ? "Roll join" : `Trim ${drag.edge}`} ${lifecycle.deltaSec >= 0 ? "+" : ""}${lifecycle.deltaSec.toFixed(lifecycle.fine ? 3 : 2)}s${lifecycle.limited ? " · Limit reached" : lifecycle.fine ? " · Fine drag" : ""} · Esc to cancel`}
                </span>
              )}
              {words.length > 0 ? (
                <span className="edit-boundary-restored-side">
                  Restores {side} join
                </span>
              ) : null}
              <GhostWordChips
                words={visibleWords}
                label="Preview restored words"
              />
              {words.length > visibleWords.length ? (
                <span> · +{words.length - visibleWords.length} more words</span>
              ) : null}
              {abbreviated ? <span> · Long words abbreviated</span> : null}
            </section>,
            document.body,
          );
        })();

  return (
    <span className="edit-boundary-cluster">
      <button
        ref={markRef}
        type="button"
        className={`edit-boundary-mark${dragging ? " dragging" : ""}${boundary.has_cutaway ? " has-cutaway" : ""}`}
        title={
          !canEdit
            ? "Boundary editing is only available to editors"
            : canOpenPrecision
              ? tip
              : "Drag to adjust this boundary. Precision audition is only available in the host editor."
        }
        aria-label={
          !canEdit
            ? "Boundary editing is only available to editors"
            : canOpenPrecision
              ? tip
              : "Drag to adjust boundary; precision audition is only available in the host editor"
        }
        aria-grabbed={dragging}
        aria-busy={lifecycle.kind === "pending"}
        disabled={!canEdit || lifecycle.kind === "pending"}
        data-boundary-id={boundary.id}
        style={
          dragging
            ? {
                transform: `translateX(${lifecycle.visualDeltaPx / lifecycle.gesture.rootRem}rem)`,
              }
            : undefined
        }
        onPointerDown={startDrag}
        onClick={(event) => {
          if (suppressClickRef.current && event.detail > 0) {
            suppressClickRef.current = false;
            return;
          }
          suppressClickRef.current = false;
          if (canOpenPrecision && !activeRef.current && !pendingRef.current) {
            markRef.current?.focus({ preventScroll: true });
            setPrecisionOpen(true);
          }
        }}
        onBlur={cancel}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !activeRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }}
      >
        <span className="edit-boundary-glyph" aria-hidden>
          ¦
        </span>
      </button>
      {canEdit && resolvedTarget && precisionOpen ? (
        <PrecisionBoundaryDialog
          open={precisionOpen}
          onClose={() => setPrecisionOpen(false)}
          projectPath={projectPath}
          target={resolvedTarget}
          expectedGeometry={resolvedGeometry}
          boundary={boundary}
          onApply={applyBoundary}
        />
      ) : null}
      {feedback}
    </span>
  );
}
