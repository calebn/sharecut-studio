import { useEffect, useLayoutEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import type { DawStore } from "../state/types";
import {
  followPageTarget,
  isPlayheadOffscreen,
  revealTargetPx,
} from "../utils/timelineFollow";
import { timelineCanvasSize } from "../utils/timelineViewport";
import type { ScrollBinding } from "./useFixedPlayheadScroll";

type Props = Readonly<{
  binding: ScrollBinding;
  sessionSec: number;
}>;

/**
 * A timeline mounting turns the follow on, which sheds a flag the phone or
 * another stage left off. It subscribes instead of rendering per tick, and
 * sizes the canvas from the store's zoom so a zoom lands on its own canvas.
 * Writes go through the binding's `writeScroll`, so the scroll handler counts
 * them as ours; they are plain `scrollLeft` assignments because the echo check
 * needs the write to land at once, so the timeline scroller must never get
 * `scroll-behavior: smooth`. The phone's fixed playhead and presence Follow
 * own their own viewport. It never writes the playhead.
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
      current.writeScroll(el, target, current.leadPx);
      useDawStore.getState().setScrollLeft(target);
    };
    const reveal = (s: DawStore) => {
      const view = {
        playheadSec: s.playheadSec,
        zoomPxPerSec: s.zoomPxPerSec,
        viewportPx: latest.current.binding.timeViewportPx,
      };
      if (isPlayheadOffscreen({ ...view, scrollPx: s.scrollLeft })) {
        moveTo(
          revealTargetPx({
            ...view,
            canvasWidthPx: canvasWidth(s.zoomPxPerSec),
          }),
        );
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
