/**
 * The Inspector column (#1696) sits beside the timeline, so it covers no lane
 * and caps nothing. The lane being edited still has to be whole on screen,
 * between the pinned chrome and the scroller's end, and stay so when the
 * screen turns. This scrolls it there, and only scrolls.
 */
import { useLayoutEffect, useRef } from "react";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { pinnedChromeBottom } from "./useCompactInspector";
import { laneSelector } from "./useKeepEditedLaneClear";

export function revealLane(trackId: string): void {
  const lane = document.querySelector(laneSelector(trackId));
  const scroller = lane?.closest<HTMLElement>(".timeline-scroll");
  if (!lane || !scroller) return;
  const chrome = pinnedChromeBottom(scroller);
  const box = lane.getBoundingClientRect();
  const below = box.bottom - scroller.getBoundingClientRect().bottom;
  if (below > 0) scroller.scrollTop += Math.min(below, box.top - chrome);
  const hidden = chrome - lane.getBoundingClientRect().top;
  if (hidden > 0) scroller.scrollTop -= hidden;
}

/** Keeps lane `trackId` whole in its scroller while set; null does nothing. */
export function useRevealEditedLane(trackId: string | null): void {
  const frame = useRef(0);
  // A rotation resizes the scroller after the effect below runs; the refit
  // moves layout, so it waits a frame, as in `useKeepEditedLaneClear`.
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
