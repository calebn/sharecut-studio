import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

function setDragLock(on: boolean) {
  document.body.classList.toggle(DRAG_CLASS, on);
  document.querySelector(".transcript-list")?.classList.toggle(DRAG_CLASS, on);
}

/**
 * Descript-style edit-boundary glyph.
 * Both neighbors → roll join; single neighbor → TrimClipEdge.
 */
export function EditBoundaryMarkView({
  boundary,
  leftClip,
  rightClip,
  getRollBounds,
  onRoll,
  onTrim,
}: EditBoundaryMarkViewProps) {
  const dragRef = useRef<DragState | null>(null);
  const removeWindowListenersRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewDxPx, setPreviewDxPx] = useState(0);
  const [previewDeltaSec, setPreviewDeltaSec] = useState(0);
  const tip =
    leftClip && rightClip
      ? capabilityTooltip("daw.edit.rollClipJoin")
      : capabilityTooltip("daw.view.editBoundary");

  useEffect(() => {
    return () => {
      removeWindowListenersRef.current?.();
      removeWindowListenersRef.current = null;
      dragRef.current = null;
      setDragLock(false);
    };
  }, []);

  const previewTrim = (state: TrimDragState, clientX: number) => {
    const dxSec = (clientX - state.originX) / BOUNDARY_PX_PER_SEC;
    const proposed = sourceSecFromTimelineDelta(state.baseSourceSec, dxSec);
    const sourceSec = clampTrimSourceSec(
      state.edge,
      proposed,
      state.sourceStart,
      state.sourceEnd,
      state.neighborLo,
      state.neighborHi,
    );
    const clampedDxSec = sourceSec - state.baseSourceSec;
    setPreviewDxPx(clampedDxSec * BOUNDARY_PX_PER_SEC);
    setPreviewDeltaSec(clampedDxSec);
    return sourceSec;
  };

  const previewRoll = (state: RollDragState, clientX: number) => {
    const dxSec = (clientX - state.originX) / BOUNDARY_PX_PER_SEC;
    const delta = clampRollDelta(dxSec, {
      leftSourceStart: state.leftSourceStart,
      leftSourceEnd: state.leftSourceEnd,
      rightSourceStart: state.rightSourceStart,
      rightSourceEnd: state.rightSourceEnd,
      prevSourceEnd: state.prevSourceEnd,
      nextSourceStart: state.nextSourceStart,
      mediaEnd: state.mediaEnd,
    });
    setPreviewDxPx(delta * BOUNDARY_PX_PER_SEC);
    setPreviewDeltaSec(delta);
    return delta;
  };

  const endDrag = async (clientX: number) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragLock(false);
    setDragging(false);
    setPreviewDxPx(0);
    setPreviewDeltaSec(0);
    if (!d) {
      return;
    }
    if (d.kind === "roll") {
      const dxSec = (clientX - d.originX) / BOUNDARY_PX_PER_SEC;
      const delta = clampRollDelta(dxSec, {
        leftSourceStart: d.leftSourceStart,
        leftSourceEnd: d.leftSourceEnd,
        rightSourceStart: d.rightSourceStart,
        rightSourceEnd: d.rightSourceEnd,
        prevSourceEnd: d.prevSourceEnd,
        nextSourceStart: d.nextSourceStart,
        mediaEnd: d.mediaEnd,
      });
      if (Math.abs(delta) < 1e-3) {
        return;
      }
      await onRoll(d.leftClipId, d.rightClipId, delta);
      return;
    }
    const dxSec = (clientX - d.originX) / BOUNDARY_PX_PER_SEC;
    const proposed = sourceSecFromTimelineDelta(d.baseSourceSec, dxSec);
    const sourceSec = clampTrimSourceSec(
      d.edge,
      proposed,
      d.sourceStart,
      d.sourceEnd,
      d.neighborLo,
      d.neighborHi,
    );
    if (Math.abs(sourceSec - d.baseSourceSec) < 1e-3) {
      return;
    }
    await onTrim(d.clipId, d.edge, sourceSec);
  };

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragRef.current) {
      // One drag at a time: ignore a second pointer (e.g. another finger).
      return;
    }
    const pointerId = e.pointerId;
    const el = e.currentTarget;

    if (leftClip && rightClip) {
      const n = getRollBounds();
      dragRef.current = {
        kind: "roll",
        originX: e.clientX,
        leftClipId: leftClip.id,
        rightClipId: rightClip.id,
        leftSourceStart: leftClip.source_start,
        leftSourceEnd: leftClip.source_end,
        rightSourceStart: rightClip.source_start,
        rightSourceEnd: rightClip.source_end,
        prevSourceEnd: n.prevSourceEnd,
        nextSourceStart: n.nextSourceStart,
        mediaEnd: n.mediaEnd,
        pointerId,
      };
    } else {
      const clip = leftClip ?? rightClip;
      if (!clip) {
        return;
      }
      const useLeft = leftClip != null;
      dragRef.current = {
        kind: "trim",
        originX: e.clientX,
        edge: useLeft ? "out" : "in",
        clipId: clip.id,
        baseSourceSec: useLeft ? clip.source_end : clip.source_start,
        sourceStart: clip.source_start,
        sourceEnd: clip.source_end,
        neighborLo: 0,
        neighborHi: Number.POSITIVE_INFINITY,
        pointerId,
      };
    }

    setDragging(true);
    setPreviewDxPx(0);
    setPreviewDeltaSec(0);
    setDragLock(true);

    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Window listeners below still complete the drag.
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !dragRef.current) {
        return;
      }
      ev.preventDefault();
      const state = dragRef.current;
      if (state.kind === "roll") {
        previewRoll(state, ev.clientX);
      } else {
        previewTrim(state, ev.clientX);
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) {
        return;
      }
      removeListeners();
      try {
        if (el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
      void endDrag(ev.clientX);
    };

    // Closure-local so each drag removes only its own listeners; the ref
    // lets the unmount effect reach the active drag's remover.
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      // Always true today: startDrag ignores a second pointer while
      // dragRef is set, so no newer drag can own the ref yet. Kept so that
      // relaxing that guard never clears another drag's remover.
      if (removeWindowListenersRef.current === removeListeners) {
        removeWindowListenersRef.current = null;
      }
    };

    window.addEventListener("pointermove", onMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    removeWindowListenersRef.current = removeListeners;
  };

  const deltaLabel =
    dragging && Math.abs(previewDeltaSec) >= 0.05
      ? `${previewDeltaSec > 0 ? "+" : ""}${previewDeltaSec.toFixed(1)}s`
      : null;

  const isRoll = leftClip != null && rightClip != null;
  const previewKind = isRoll ? "roll" : "trim";
  const previewEdge: "in" | "out" | undefined = isRoll
    ? undefined
    : leftClip
      ? "out"
      : "in";
  const leftEnd = leftClip?.source_end ?? boundary.cutaway_source_start;
  const rightStart = rightClip?.source_start ?? boundary.cutaway_source_end;

  const ghostWords = useMemo(() => {
    if (!dragging || Math.abs(previewDeltaSec) < 1e-3) {
      return [];
    }
    const range = expandGhostSourceRange({
      kind: previewKind,
      deltaSec: previewDeltaSec,
      edge: previewEdge,
      leftSourceEnd: leftEnd,
      rightSourceStart: rightStart,
    });
    return ghostWordsForExpandPreview(boundary.cutaway_word_ids, range);
  }, [
    dragging,
    previewDeltaSec,
    previewKind,
    previewEdge,
    leftEnd,
    rightStart,
    boundary.cutaway_word_ids,
  ]);

  const ghostSide = useMemo(() => {
    if (!dragging) {
      return null;
    }
    return ghostPlacementForExpand({
      kind: previewKind,
      deltaSec: previewDeltaSec,
      edge: previewEdge,
    });
  }, [dragging, previewKind, previewEdge, previewDeltaSec]);

  const ghostBefore =
    ghostSide === "before" ? (
      <GhostWordChips words={ghostWords} label="Preview restored words" />
    ) : null;
  const ghostAfter =
    ghostSide === "after" ? (
      <GhostWordChips words={ghostWords} label="Preview restored words" />
    ) : null;

  return (
    <span className="edit-boundary-cluster">
      {ghostBefore}
      {/*
        aria-grabbed is kept on purpose to match the pre-extraction mark,
        although ARIA 1.2 deprecates it. axe reports it as needs-review
        (rule aria-allowed-attr, check aria-no-deprecated-attr → incomplete),
        not a violation; EditBoundaryMark.test.tsx pins that. Replace it
        with a live-region or aria-description drag message if axe starts
        failing on it; do not just delete it.
      */}
      <button
        type="button"
        className={`edit-boundary-mark${dragging ? " dragging" : ""}${boundary.has_cutaway ? " has-cutaway" : ""}`}
        title={tip}
        aria-label={tip}
        aria-grabbed={dragging}
        data-boundary-id={boundary.id}
        style={
          dragging ? { transform: `translateX(${previewDxPx}px)` } : undefined
        }
        onPointerDown={startDrag}
      >
        <span className="edit-boundary-glyph" aria-hidden>
          ¦
        </span>
        {deltaLabel ? (
          <span className="edit-boundary-delta" aria-hidden>
            {deltaLabel}
          </span>
        ) : null}
      </button>
      {ghostAfter}
    </span>
  );
}
