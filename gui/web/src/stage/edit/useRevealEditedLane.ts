/**
 * The Inspector column (#1696) sits beside the timeline, so it covers no lane
 * and caps nothing. The lane being edited still has to be whole on screen,
 * between the pinned chrome and the scroller's end, and stay so when the
 * screen turns. This scrolls it there, and only scrolls.
 */
import { useLayoutEffect, useRef } from "react";
import { laneSelector, revealLane } from "../../commands/timelineReveal";
import { useResizeObserver } from "../../ui/useResizeObserver";

/** Keeps lane `trackId` whole in its scroller while set; null does nothing. */
export function useRevealEditedLane(trackId: string | null): void {
  const frame = useRef(0);
  // A rotation resizes the scroller after the effect below runs; the refit
  // moves layout, so it waits a frame.
  useResizeObserver(
    [
      () => (trackId ? document.querySelector(laneSelector(trackId)) : null),
      () => document.querySelector(".timeline-scroll"),
    ],
    () => {
      if (trackId === null || frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        revealLane(trackId);
      });
    },
    trackId !== null,
  );
  useLayoutEffect(() => {
    if (trackId === null) return;
    revealLane(trackId);
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [trackId]);
}
