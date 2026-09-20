import { type RefObject, useEffect } from "react";
import { useDawStore } from "../state/dawStore";
import type { PresenceCursor } from "../types/session";
import { LANE_HEIGHT } from "../utils/layout";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import { anchorFractions, findPresenceAnchor } from "./anchors";
import { setPresenceCursor } from "./followSync";

export function presenceCursorFromPointer(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
  lanesEl: HTMLElement | null,
  scrollLeft: number,
  zoomPxPerSec: number,
  canvasSec: number,
): PresenceCursor | null {
  const lane =
    target instanceof Element
      ? target.closest<HTMLElement>(".lane-row[data-track-id]")
      : null;
  if (lane && lanesEl) {
    const rect = lanesEl.getBoundingClientRect();
    const lanePos = Math.max(0, (clientY - rect.top) / LANE_HEIGHT);
    return {
      t_sec: clientXToTimelineSec(
        clientX,
        lanesEl,
        scrollLeft,
        zoomPxPerSec,
        canvasSec,
      ),
      track_id: lane.dataset.trackId ?? null,
      lane_pos: Number(lanePos.toFixed(3)),
    };
  }
  const hit = findPresenceAnchor(target);
  if (!hit) {
    return null;
  }
  const { x, y } = anchorFractions(hit.el, clientX, clientY);
  return {
    anchor: hit.id,
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
  };
}

export function usePresenceCursorSource(
  rootRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        return;
      }
      const s = useDawStore.getState();
      const canvasSec = s.project?.timeline_duration_sec ?? 0;
      setPresenceCursor(
        presenceCursorFromPointer(
          e.target,
          e.clientX,
          e.clientY,
          s._lanesEl,
          s.scrollLeft,
          s.zoomPxPerSec,
          canvasSec,
        ),
      );
    };
    const onLeave = () => setPresenceCursor(null);
    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [rootRef]);
}
