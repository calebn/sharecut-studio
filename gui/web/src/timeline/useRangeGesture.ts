import { type PointerEvent, type RefObject, useRef } from "react";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import type { ProjectView, Selection } from "../types/project";

export type RangePoint = { clientX: number; clientY: number };
export type RangeGesture = (
  stage: "start" | "move" | "end" | "cancel",
  point: RangePoint,
) => void;

export function useRangeGesture(
  lanesRef: RefObject<HTMLDivElement | null>,
  zoom: number,
  duration: number,
) {
  const draft = useRef<{
    origin: RangePoint;
    project: ProjectView;
    previous: Selection;
    drawing: boolean;
    epoch: number;
    painted: Selection;
    pointerId: number | null;
  } | null>(null);
  const suppressClick = useRef(false);
  function cancel() {
    const active = draft.current;
    draft.current = null;
    const state = useDawStore.getState();
    if (
      active?.drawing &&
      active.epoch === state.projectEpoch &&
      active.painted === state.selection
    )
      state.setSelection(active.previous);
  }
  const gesture: RangeGesture = (stage, point) => {
    const state = useDawStore.getState();
    if (
      stage === "cancel" ||
      state.joinMutationInFlight ||
      state.toolMode !== "select"
    ) {
      cancel();
      return;
    }
    const lanes = lanesRef.current;
    if (!lanes || !state.project) return;
    if (stage === "start") {
      draft.current = {
        origin: point,
        project: state.project,
        previous: state.selection,
        drawing: false,
        epoch: state.projectEpoch,
        painted: state.selection,
        pointerId: null,
      };
      return;
    }
    const active = draft.current;
    if (!active) return;
    if (
      active.epoch !== state.projectEpoch ||
      (active.drawing && state.selection !== active.painted)
    ) {
      draft.current = null;
      return;
    }
    if (
      Math.hypot(
        point.clientX - active.origin.clientX,
        point.clientY - active.origin.clientY,
      ) < 4 &&
      !active.drawing
    ) {
      if (stage === "end") draft.current = null;
      return;
    }
    const rect = lanes.getBoundingClientRect();
    const start = Math.max(
      0,
      Math.min(
        duration,
        (Math.min(active.origin.clientX, point.clientX) - rect.left) / zoom,
      ),
    );
    const end = Math.max(
      0,
      Math.min(
        duration,
        (Math.max(active.origin.clientX, point.clientX) - rect.left) / zoom,
      ),
    );
    const top = Math.min(active.origin.clientY, point.clientY),
      bottom = Math.max(active.origin.clientY, point.clientY);
    const ids = [
      ...lanes.querySelectorAll<HTMLElement>(".lane-row[data-track-id]"),
    ]
      .filter((lane) => {
        const r = lane.getBoundingClientRect();
        return r.bottom > top && r.top <= bottom;
      })
      .map((lane) => lane.dataset.trackId!)
      .filter(Boolean);
    const target = makeRangeTarget(active.project, [{ start, end }], ids);
    if (target) {
      active.drawing = true;
      active.painted = { kind: "range", target };
      state.setSelection(active.painted);
      suppressClick.current = true;
    }
    if (stage === "end") {
      draft.current = null;
      state.setRangeArmed(false);
    }
  };
  return {
    gesture,
    captureDown(event: PointerEvent<HTMLDivElement>) {
      const state = useDawStore.getState();
      const target = event.target;
      if (
        !(target instanceof Element) ||
        state.toolMode !== "select" ||
        state.commentMode ||
        state.joinMutationInFlight
      )
        return;
      if (draft.current) {
        cancel();
        return;
      }
      const button = target.closest("button");
      if (
        (button && !button.matches(".clip-hit")) ||
        target.closest(
          "input,.trim-handle,.fade-corner,.join-seam,.envelope-overlay,.pending-overlay,.applied-tick",
        )
      )
        return;
      if (
        !state.rangeArmed &&
        (event.pointerType === "touch" || !target.closest(".lane-seek"))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      gesture("start", event);
      const active = draft.current as { pointerId: number | null } | null;
      if (active) active.pointerId = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    captureMove(event: PointerEvent<HTMLDivElement>) {
      if (draft.current?.pointerId === event.pointerId) gesture("move", event);
    },
    captureUp(event: PointerEvent<HTMLDivElement>) {
      if (draft.current?.pointerId === event.pointerId) {
        gesture("end", event);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
    },
    captureCancel() {
      cancel();
    },
    captureClick(event: {
      preventDefault: () => void;
      stopPropagation: () => void;
    }) {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
