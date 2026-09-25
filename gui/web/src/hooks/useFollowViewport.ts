import { useEffect, useRef } from "react";
import {
  resolveFollowTarget,
  serverNowMs,
  viewportToZoomScroll,
  withProgrammaticScroll,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import { sessionSecOf } from "../utils/zoom";

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
    const { zoomPxPerSec: zoom, scrollLeft } = viewportToZoomScroll(
      v,
      state.measureTimelineViewport(),
      sessionSecOf(state),
    );
    withProgrammaticScroll(() => {
      useDawStore.getState().setZoomPxPerSec(zoom);
      useDawStore.getState().setScrollLeft(scrollLeft);
      useDawStore.getState().markUserZoomed();
    });
  }, [followingClientId, sessionClients, serverClockOffsetMs, shellBreakpoint]);
}
