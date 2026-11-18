import { useEffect, useLayoutEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import type { DawStore } from "../state/types";
import {
  followPageTarget,
  isPlayheadOffscreen,
  revealTargetPx,
} from "../utils/timelineFollow";
import {
  SCROLL_SYNC_EPS_PX,
  timelineCanvasSize,
} from "../utils/timelineViewport";
import type { ScrollBinding } from "./useFixedPlayheadScroll";

type Props = Readonly<{
  binding: ScrollBinding;
  sessionSec: number;
}>;

type Mover = Pick<ScrollBinding, "writeScroll" | "leadPx">;

function moveScrollTo(
  { writeScroll, leadPx }: Mover,
  el: HTMLElement,
  target: number,
): boolean {
  const before = el.scrollLeft;
  writeScroll(el, target, leadPx);
  useDawStore.getState().setScrollLeft(target);
  return Math.abs(el.scrollLeft - before) > SCROLL_SYNC_EPS_PX;
}

export function revealPlayhead(
  binding: Mover,
  el: HTMLElement,
  view: { viewportPx: number; canvasWidthPx: number },
): boolean {
  const { playheadSec, zoomPxPerSec } = useDawStore.getState();
  return moveScrollTo(
    binding,
    el,
    revealTargetPx({ playheadSec, zoomPxPerSec, ...view }),
  );
}

/**
 * Writes go through `writeScroll` and land at once, so the echo check can tell
 * them from a person's scroll: the timeline scroller must never get
 * `scroll-behavior: smooth`.
 */
export function TimelineFollow({ binding, sessionSec }: Props) {
  const latest = useRef({ binding, sessionSec });
  useLayoutEffect(() => {
    latest.current = { binding, sessionSec };
  });
  const { fixedPlayhead } = binding;
  useEffect(() => {
    if (fixedPlayhead) {
      return;
    }
    useDawStore.getState().setTimelineFollowPlayhead(true);
    const canvasWidth = (zoomPxPerSec: number) => {
      const { binding: current, sessionSec: session } = latest.current;
      return timelineCanvasSize(session, zoomPxPerSec, current.timeViewportPx)
        .widthPx;
    };
    const moveTo = (target: number) => {
      const { binding: current } = latest.current;
      const el = current.scrollRef.current;
      if (!el) {
        return;
      }
      moveScrollTo(current, el, target);
    };
    const reveal = (s: DawStore) => {
      const { binding: current } = latest.current;
      const el = current.scrollRef.current;
      const viewportPx = current.timeViewportPx;
      if (
        el &&
        isPlayheadOffscreen({
          playheadSec: s.playheadSec,
          zoomPxPerSec: s.zoomPxPerSec,
          viewportPx,
          scrollPx: s.scrollLeft,
        })
      ) {
        revealPlayhead(current, el, {
          viewportPx,
          canvasWidthPx: canvasWidth(s.zoomPxPerSec),
        });
      }
    };
    return useDawStore.subscribe((s, prev) => {
      if (!s.isPlaying || s.followingClientId) {
        return;
      }
      if (!prev.isPlaying) {
        s.setTimelineFollowPlayhead(true);
        reveal(s);
        return;
      }
      if (s.playheadSeekRevision !== prev.playheadSeekRevision) {
        reveal(s);
        return;
      }
      if (
        !s.timelineFollowPlayhead ||
        (s.playheadSec === prev.playheadSec &&
          s.zoomPxPerSec === prev.zoomPxPerSec)
      ) {
        return;
      }
      const target = followPageTarget({
        playheadSec: s.playheadSec,
        zoomPxPerSec: s.zoomPxPerSec,
        viewportPx: latest.current.binding.timeViewportPx,
        canvasWidthPx: canvasWidth(s.zoomPxPerSec),
        scrollPx: s.scrollLeft,
      });
      if (target !== null) {
        moveTo(target);
      }
    });
  }, [fixedPlayhead]);
  return null;
}
