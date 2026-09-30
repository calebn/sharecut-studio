import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import type { ClipRow, EditBoundaryView } from "../types/project";
import { GhostWordChips } from "./GhostWordChips";
import { TRANSCRIPT_EDIT_BOUNDARY_TIP } from "./transcriptModeCopy";

export interface EditBoundaryMarkViewProps {
  boundary: EditBoundaryView;
  leftClip: ClipRow | null;
  rightClip: ClipRow | null;
  /** Roll clamp neighbours (`rollNeighborBounds`), read when a roll drag starts. */
  getRollBounds: () => RollNeighborBounds;
  onRoll: (
    leftClipId: string,
    rightClipId: string,
    deltaSec: number,
  ) => Promise<void> | void;
  onTrim: (
    clipId: string,
    edge: TrimEdge,
    sourceSec: number,
  ) => Promise<void> | void;
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

const DRAG_CLASS = "is-boundary-dragging";

type Gesture = {
  drag: DragState;
  boundary: EditBoundaryView;
  rect: DOMRect;
  rootRem: number;
  previewGapPx: number;
};

type Lifecycle =
  | { kind: "idle" }
  | { kind: "dragging"; gesture: Gesture; deltaSec: number; limited: boolean }
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

export function EditBoundaryMarkView({
  boundary,
  leftClip,
  rightClip,
  getRollBounds,
  onRoll,
  onTrim,
}: EditBoundaryMarkViewProps) {
  const markRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef<Gesture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const [lifecycle, setLifecycle] = useState<Lifecycle>({ kind: "idle" });
  const dragging = lifecycle.kind === "dragging";
  const tip =
    leftClip && rightClip
      ? capabilityTooltip("daw.edit.rollClipJoin")
      : TRANSCRIPT_EDIT_BOUNDARY_TIP;

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
    event.preventDefault();
    event.stopPropagation();
    if (
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
      rect: el.getBoundingClientRect(),
      rootRem,
      previewGapPx: gapRem * rootRem,
    };
    const transcript = el.closest(".transcript-list");
    activeRef.current = gesture;
    setLifecycle({ kind: "dragging", gesture, deltaSec: 0, limited: false });
    document.body.classList.add(DRAG_CLASS);
    transcript?.classList.add(DRAG_CLASS);
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(pointerId);
    } catch {}

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || activeRef.current !== gesture) return;
      ev.preventDefault();
      const deltaSec = deltaForDrag(drag, ev.clientX);
      setLifecycle({
        kind: "dragging",
        gesture,
        deltaSec,
        limited:
          Math.abs(
            deltaSec - (ev.clientX - drag.originX) / BOUNDARY_PX_PER_SEC,
          ) > 1e-6,
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
      const deltaSec = deltaForDrag(drag, ev.clientX);
      cleanup();
      if (Math.abs(deltaSec) < 1e-3) {
        setLifecycle({ kind: "idle" });
        return;
      }
      pendingRef.current = true;
      setLifecycle({ kind: "pending", gesture });
      void (async () => {
        try {
          if (drag.kind === "roll")
            await onRoll(drag.leftClipId, drag.rightClipId, deltaSec);
          else
            await onTrim(drag.clipId, drag.edge, drag.baseSourceSec + deltaSec);
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
      document.body.classList.remove(DRAG_CLASS);
      transcript?.classList.remove(DRAG_CLASS);
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
            <div
              className={`edit-boundary-preview${lifecycle.kind === "error" ? " edit-boundary-preview-error" : ""}`}
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
                    : `${drag.kind === "roll" ? "Roll join" : `Trim ${drag.edge}`} ${lifecycle.deltaSec >= 0 ? "+" : ""}${lifecycle.deltaSec.toFixed(2)}s${lifecycle.limited ? " · Limit reached" : ""} · Esc to cancel`}
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
            </div>,
            document.body,
          );
        })();

  return (
    <span className="edit-boundary-cluster">
      <button
        ref={markRef}
        type="button"
        className={`edit-boundary-mark${dragging ? " dragging" : ""}${boundary.has_cutaway ? " has-cutaway" : ""}`}
        title={tip}
        aria-label={tip}
        aria-grabbed={dragging}
        aria-busy={lifecycle.kind === "pending"}
        disabled={lifecycle.kind === "pending"}
        data-boundary-id={boundary.id}
        style={
          dragging
            ? {
                transform: `translateX(${(lifecycle.deltaSec * BOUNDARY_PX_PER_SEC) / lifecycle.gesture.rootRem}rem)`,
              }
            : undefined
        }
        onPointerDown={startDrag}
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
      {feedback}
    </span>
  );
}
