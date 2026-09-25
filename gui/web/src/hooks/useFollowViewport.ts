import { useEffect, useRef } from "react";
import {
  resolveFollowTarget,
  serverNowMs,
  viewportToZoomScroll,
  withProgrammaticScroll,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { clampZoomPxPerSec, sessionSecOf } from "../utils/zoom";

export function useFollowViewport(): void {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) => s.sessionClients);
  const serverClockOffsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const shellBreakpoint = useDawStore((s) => s.shellBreakpoint);
  const lastVp = useRef<string>("");

  useEffect(() => {
    if (!followingClientId || shellBreakpoint === "phone") {
      lastVp.current = "";
      return;
    }
    const now = serverNowMs(serverClockOffsetMs);
    const target = resolveFollowTarget(sessionClients, followingClientId, now);
    if (!target) {
      useDawStore.getState().stopFollow("left");
      return;
    }
    const v = target.meta?.viewport;
    if (!v) {
      return;
    }
    const sig = `${v.start_sec}:${v.end_sec}`;
    if (sig === lastVp.current) {
      return;
    }
    lastVp.current = sig;
    const state = useDawStore.getState();
    const width = state.measureTimelineViewport();
    const { zoomPxPerSec } = viewportToZoomScroll(v, width);
    // The leader may zoom past this session's ceiling (another viewport
    // width); scroll to their start at the zoom this view can show.
    const zoom = clampZoomPxPerSec(zoomPxPerSec, sessionSecOf(state));
    const scrollLeft = Math.max(0, v.start_sec * zoom);
    withProgrammaticScroll(() => {
      useDawStore.getState().setZoomPxPerSec(zoom);
      useDawStore.getState().setScrollLeft(scrollLeft);
      useDawStore.getState().markUserZoomed();
    });
  }, [followingClientId, sessionClients, serverClockOffsetMs, shellBreakpoint]);
}
