import { useEffect } from "react";
import { playbackPositionSec } from "../audio/playbackClock";
import {
  expectedPlayheadSec,
  type NudgeClock,
  planCorrection,
  resolveFollowTarget,
  serverNowMs,
} from "../presence/followSync";
import { sessionClientList } from "../presence/roster";
import { useDawStore } from "../state/dawStore";

const CORRECTION_MS = 250;
const STARTUP_RATE_ADJUSTMENT = 0.03;

type PlaybackPhase =
  | { kind: "waiting"; seeked: boolean }
  | { kind: "steady" }
  | { kind: "aligning"; direction: -1 | 1; deadlineMs: number };

export function useFollowTransport(): void {
  const followingClientId = useDawStore((s) => s.followingClientId);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const auditionMode = useDawStore((s) => s.auditionMode);

  useEffect(() => {
    if (!followingClientId) {
      return;
    }
    let playbackPhase: PlaybackPhase = { kind: "steady" };
    let previousTarget: string | null = null;
    let previousPlaying: boolean | null = null;
    const nudgeClock: NudgeClock = { startedAt: null };
    const correct = (seek = false) => {
      const s = useDawStore.getState();
      const now = serverNowMs();
      const target = resolveFollowTarget(
        sessionClientList(s.sessionClients),
        followingClientId,
        now,
      );
      if (!target) {
        s.stopFollow("left");
        return;
      }
      const t = target.meta?.transport;
      if (!t) {
        return;
      }
      if (previousTarget !== target.client_id) {
        previousTarget = target.client_id;
        previousPlaying = null;
        nudgeClock.startedAt = null;
        playbackPhase = { kind: "steady" };
      }
      const expected = expectedPlayheadSec(
        t,
        now,
        s.project?.timeline_duration_sec ?? 1e9,
      );
      const baseRate = Number.isFinite(t.rate) && t.rate > 0 ? t.rate : 1;
      if (!Number.isFinite(expected)) return;
      if (!t.playing) playbackPhase = { kind: "steady" };
      if (previousPlaying !== true && t.playing) {
        s.setPlayheadSec(expected);
        s.setPlaybackRate(baseRate);
        s.setIsPlaying(true);
        playbackPhase = { kind: "waiting", seeked: false };
      } else if (!t.playing && (previousPlaying === true || s.isPlaying)) {
        s.setIsPlaying(false);
        s.setPlayheadSec(t.playhead_sec);
        s.setPlaybackRate(baseRate);
        nudgeClock.startedAt = null;
      } else if (t.playing && s.isPlaying && seek) {
        s.setPlayheadSec(expected);
        s.setPlaybackRate(baseRate);
        playbackPhase = { kind: "waiting", seeked: true };
      } else if (t.playing && s.isPlaying) {
        const localPosition = playbackPositionSec();
        if (playbackPhase.kind !== "steady") {
          if (localPosition == null) return;
          const errorSec = expected - localPosition;
          const nowMs = performance.now();
          if (playbackPhase.kind === "waiting") {
            const startupPlan = planCorrection(localPosition, expected);
            if (startupPlan.action === "seek") {
              if (playbackPhase.seeked) {
                playbackPhase = { kind: "steady" };
                s.setPlaybackRate(baseRate);
              } else {
                playbackPhase = { kind: "waiting", seeked: true };
                s.setPlayheadSec(startupPlan.toSec);
              }
              return;
            }
            if (errorSec === 0) {
              playbackPhase = { kind: "steady" };
              s.setPlaybackRate(baseRate);
              return;
            }
            playbackPhase = {
              kind: "aligning",
              direction: errorSec < 0 ? -1 : 1,
              deadlineMs:
                nowMs +
                (Math.abs(errorSec) / (baseRate * STARTUP_RATE_ADJUSTMENT)) *
                  1000 +
                CORRECTION_MS,
            };
          }
          if (
            errorSec * playbackPhase.direction <= 0 ||
            nowMs >= playbackPhase.deadlineMs
          ) {
            playbackPhase = { kind: "steady" };
            s.setPlaybackRate(baseRate);
          } else {
            s.setPlaybackRate(
              baseRate *
                (1 + playbackPhase.direction * STARTUP_RATE_ADJUSTMENT),
            );
          }
          return;
        }
        const plan = planCorrection(
          localPosition ?? s.playheadSec,
          expected,
          undefined,
          Date.now(),
          nudgeClock,
        );
        if (plan.action === "seek") s.setPlayheadSec(plan.toSec);
        s.setPlaybackRate(baseRate * (plan.action === "nudge" ? plan.rate : 1));
      } else if (!t.playing) {
        if (Math.abs(s.playheadSec - t.playhead_sec) > 0.05) {
          s.setPlayheadSec(t.playhead_sec);
        }
        s.setPlaybackRate(baseRate);
      }
      previousPlaying = t.playing;
    };
    correct();
    const timer = window.setInterval(correct, CORRECTION_MS);
    const unsubscribe = useDawStore.subscribe((s, prev) => {
      if (s.sessionClients === prev.sessionClients) return;
      const now = serverNowMs();
      const target = resolveFollowTarget(
        sessionClientList(s.sessionClients),
        followingClientId,
        now,
      );
      const previous = resolveFollowTarget(
        sessionClientList(prev.sessionClients),
        followingClientId,
        now,
      );
      const nextTransport = target?.meta?.transport;
      const previousTransport = previous?.meta?.transport;
      const positionJump =
        nextTransport &&
        previousTransport &&
        (!nextTransport.playing
          ? nextTransport.playhead_sec !== previousTransport.playhead_sec
          : nextTransport.stamped_ns != null &&
            Math.abs(
              nextTransport.playhead_sec -
                expectedPlayheadSec(
                  previousTransport,
                  nextTransport.stamped_ns / 1e6,
                  s.project?.timeline_duration_sec ?? 1e9,
                ),
            ) > 0.05);
      if (nextTransport?.rate !== previousTransport?.rate) {
        playbackPhase = { kind: "waiting", seeked: false };
      }
      if (
        positionJump ||
        target?.client_id !== previous?.client_id ||
        target?.meta?.transport?.playing !==
          previous?.meta?.transport?.playing ||
        target?.meta?.transport?.rate !== previous?.meta?.transport?.rate
      )
        correct(Boolean(positionJump));
    });
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [followingClientId, projectEpoch, auditionMode]);
}
