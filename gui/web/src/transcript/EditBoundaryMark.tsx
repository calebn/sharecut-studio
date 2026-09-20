import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { rollClipJoin, trimClipEdge } from "../api";
import { capabilityTooltip } from "../capabilities/copy";
import {
  clampRollDelta,
  clampTrimSourceSec,
  sourceSecFromTimelineDelta,
} from "../edit/clipEdgePreview";
import {
  expandGhostSourceRange,
  ghostPlacementForExpand,
  ghostWordsForExpandPreview,
} from "../edit/ghostPreview";
import { useDaw } from "../state/useDaw";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { GhostWordChips } from "./GhostWordChips";

type Props = {
  boundary: EditBoundaryView;
  leftClip: ClipRow | null;
  rightClip: ClipRow | null;
};

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
export function EditBoundaryMark({ boundary, leftClip, rightClip }: Props) {
  const { projectPath, project } = useDaw();
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewDxPx, setPreviewDxPx] = useState(0);
  const [previewDeltaSec, setPreviewDeltaSec] = useState(0);
  const tip =
    leftClip && rightClip
      ? capabilityTooltip("daw.edit.rollClipJoin")
      : capabilityTooltip("daw.view.editBoundary");

  useEffect(() => {
    return () => {
      dragRef.current = null;
      setDragLock(false);
    };
  }, []);

  const rollNeighbors = () => {
    if (!leftClip || !rightClip || !project) {
      return {
        prevSourceEnd: 0,
        nextSourceStart: Number.POSITIVE_INFINITY,
        mediaEnd: Number.POSITIVE_INFINITY,
      };
    }
    const trackClips = [
      ...(project.clips.tracks[leftClip.track_id] ?? []),
    ].sort((a, b) => a.timeline_start - b.timeline_start);
    const leftIdx = trackClips.findIndex((c) => c.id === leftClip.id);
    const prev = leftIdx > 0 ? trackClips[leftIdx - 1] : null;
    const rightIdx = trackClips.findIndex((c) => c.id === rightClip.id);
    const next =
      rightIdx >= 0 && rightIdx + 1 < trackClips.length
        ? trackClips[rightIdx + 1]
        : null;
    const track = project.tracks.find((t) => t.id === leftClip.track_id);
    const mediaEnd = track?.duration_sec ?? Number.POSITIVE_INFINITY;
    return {
      prevSourceEnd: prev?.source_end ?? 0,
      nextSourceStart: next?.source_start ?? mediaEnd,
      mediaEnd,
    };
  };

  const previewTrim = (state: TrimDragState, clientX: number) => {
    const dxSec = (clientX - state.originX) / BOUNDARY_PX_PER_SEC;
    const proposed = sourceSecFromTimelineDelta(
      state.edge,
      state.baseSourceSec,
      dxSec,
    );
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
      await rollClipJoin(projectPath, d.leftClipId, d.rightClipId, delta);
      return;
    }
    const dxSec = (clientX - d.originX) / BOUNDARY_PX_PER_SEC;
    const proposed = sourceSecFromTimelineDelta(d.edge, d.baseSourceSec, dxSec);
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
    await trimClipEdge(projectPath, d.clipId, d.edge, sourceSec);
  };

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    const el = e.currentTarget;

    if (leftClip && rightClip) {
      const n = rollNeighbors();
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
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      try {
        if (el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
      void endDrag(ev.clientX);
    };

    window.addEventListener("pointermove", onMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
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
