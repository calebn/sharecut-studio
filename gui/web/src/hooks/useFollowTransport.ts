import { useEffect, useRef } from "react";
import {
  expectedPlayheadSec,
  type NudgeClock,
  planCorrection,
  resolveFollowTarget,
  serverNowMs,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";

export function useFollowTransport(): void {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const sessionClients = useDawStore((s) => s.sessionClients);
  const serverClockOffsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const playheadSec = useDawStore((s) => s.playheadSec);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const prevPlaying = useRef<boolean | null>(null);
  const nudgeClock = useRef<NudgeClock>({ startedAt: null });

  useEffect(() => {
    if (!followingClientId) {
      prevPlaying.current = null;
      nudgeClock.current.startedAt = null;
      return;
    }
    const now = serverNowMs(serverClockOffsetMs);
    const target = resolveFollowTarget(sessionClients, followingClientId, now);
    if (!target) {
      useDawStore.getState().stopFollow("left");
      return;
    }
    const t = target.meta?.transport;
    const duration =
      useDawStore.getState().project?.timeline_duration_sec ?? 1e9;
    if (t) {
      const expected = expectedPlayheadSec(t, now, duration);
      const was = prevPlaying.current;
      if (was !== true && t.playing) {
        if (Number.isFinite(expected)) {
          useDawStore.getState().setPlayheadSec(expected);
        }
        useDawStore.getState().setIsPlaying(true);
      } else if (was === true && !t.playing) {
        useDawStore.getState().setIsPlaying(false);
        useDawStore.getState().setPlayheadSec(t.playhead_sec);
      } else if (t.playing && isPlaying) {
        const plan = planCorrection(
          playheadSec,
          expected,
          undefined,
          Date.now(),
          nudgeClock.current,
        );
        if (plan.action === "seek") {
          useDawStore.getState().setPlayheadSec(plan.toSec);
          useDawStore.getState().setPlaybackRate(1);
        } else if (plan.action === "nudge") {
          useDawStore.getState().setPlaybackRate(plan.rate);
        } else {
          useDawStore.getState().setPlaybackRate(1);
        }
      } else if (!t.playing && Math.abs(playheadSec - t.playhead_sec) > 0.05) {
        useDawStore.getState().setPlayheadSec(t.playhead_sec);
      }
      prevPlaying.current = t.playing;
    }
  }, [
    followingClientId,
    sessionClients,
    serverClockOffsetMs,
    playheadSec,
    isPlaying,
  ]);
}
