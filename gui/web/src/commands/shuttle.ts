import { seekLimitSec } from "../audio/proxyMath";
import { useDawStore } from "../state/dawStore";
import { effectiveChosen } from "../state/playbackSpeed";
import { clampToSession } from "../utils/time";

const BACK_STEPS_SEC = [3, 6, 12] as const;
const REPEAT_WINDOW_MS = 1000;
const SCAN_RATES = [2, 4] as const;

let backStep = 0;
let lastBackAt = Number.NEGATIVE_INFINITY;

export function resetShuttleEscalation(): void {
  backStep = 0;
  lastBackAt = Number.NEGATIVE_INFINITY;
}

useDawStore.subscribe((s, prev) => {
  if ((prev.isPlaying && !s.isPlaying) || prev.projectPath !== s.projectPath) {
    resetShuttleEscalation();
  }
});

export function shuttleForward(): void {
  const s = useDawStore.getState();
  const chosen = effectiveChosen(s);
  const next = s.isPlaying
    ? (SCAN_RATES.find((rate) => rate > s.playbackRate) ?? 4)
    : chosen;
  if (!s.isPlaying) s.setIsPlaying(true);
  s.setPlaybackRate(next);
  s.announceStatus(`Playing ${next}×`, { toast: false });
}

export function shuttleBack(): void {
  const s = useDawStore.getState();
  const now = Date.now();
  backStep =
    now - lastBackAt < REPEAT_WINDOW_MS
      ? Math.min(backStep + 1, BACK_STEPS_SEC.length - 1)
      : 0;
  lastBackAt = now;
  const step = BACK_STEPS_SEC[backStep]!;
  const duration = seekLimitSec(s.project);
  s.setPlaybackRate(effectiveChosen(s));
  s.setPlayheadSec(clampToSession(s.playheadSec - step, duration));
  s.announceStatus(`Back ${step} s`, { toast: false });
}
