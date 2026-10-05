export const DEFAULT_AUDITION_PAD_SEC = 0.5;

export type PreviewMode = "current" | "suggested" | "ab";

export function paddedAuditionWindow(
  start: number,
  end: number,
  padSec = DEFAULT_AUDITION_PAD_SEC,
): { start: number; end: number } {
  const s = Math.max(0, start - padSec);
  const e = Math.max(s + 0.05, end + padSec);
  return { start: s, end: e };
}

export type BeginAudition = (opts: {
  playheadSec: number;
  untilSec: number;
}) => void;

/** Play a timeline range with optional padding (seconds). */
export function playTimelineRange(opts: {
  start: number;
  end: number;
  padSec?: number;
  beginAudition?: BeginAudition;
  setPlayheadSec: (sec: number) => void;
  setPlayUntilSec: (sec: number | null) => void;
  setIsPlaying: (playing: boolean) => void;
}): void {
  const { start, end } = paddedAuditionWindow(
    opts.start,
    opts.end,
    opts.padSec,
  );
  if (opts.beginAudition) {
    opts.beginAudition({ playheadSec: start, untilSec: end });
    return;
  }
  opts.setPlayheadSec(start);
  // setIsPlaying(true) clears playUntilSec (local transport ownership) — set
  // the auto-stop bound after starting playback.
  opts.setIsPlaying(true);
  opts.setPlayUntilSec(end);
}
