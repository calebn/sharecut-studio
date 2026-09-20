import type { PlayAbFollowup, PlaySkipRange } from "../state/types";

export const DEFAULT_AUDITION_PAD_SEC = 0.5;
export const DEFAULT_AB_GAP_SEC = 0.4;

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

type SkipEdit = {
  type: string;
  scope?: string;
  mappable: boolean;
  timeline_start: number | null;
  timeline_end: number | null;
  can_skip?: boolean;
  skip_reason?: string | null;
};

export function canSuggestSkip(edit: SkipEdit): boolean {
  if (typeof edit.can_skip === "boolean") {
    return edit.can_skip;
  }
  if (edit.type !== "remove") {
    return false;
  }
  if ((edit.scope ?? "session") !== "session") {
    return false;
  }
  if (!edit.mappable) {
    return false;
  }
  if (edit.timeline_start == null || edit.timeline_end == null) {
    return false;
  }
  return edit.timeline_end - edit.timeline_start > 0.02;
}

export function suggestDisabledReason(edit: SkipEdit): string | null {
  if (canSuggestSkip(edit)) {
    return null;
  }
  if (edit.skip_reason) {
    return edit.skip_reason;
  }
  if (edit.type === "split") {
    return "A split does not change the mix until you delete a side.";
  }
  if (edit.type === "mute") {
    return "Mute-in-place keeps timeline length — hear Current around the hole.";
  }
  if ((edit.scope ?? "session") === "track") {
    return "Track punch keeps timeline length — hear Current around the hole.";
  }
  if (!edit.mappable) {
    return "This cut is not on the current timeline.";
  }
  if (
    edit.timeline_start != null &&
    edit.timeline_end != null &&
    edit.timeline_end - edit.timeline_start <= 0.02
  ) {
    return "This cut is too short for a Suggested skip.";
  }
  return "Suggested skip is only for session-wide removes.";
}

export type BeginAudition = (opts: {
  playheadSec: number;
  untilSec: number;
  skip?: PlaySkipRange | null;
  abFollowup?: PlayAbFollowup | null;
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

export function playSuggestedRange(opts: {
  skipStart: number;
  skipEnd: number;
  padSec?: number;
  beginAudition: BeginAudition;
}): void {
  const { start, end } = paddedAuditionWindow(
    opts.skipStart,
    opts.skipEnd,
    opts.padSec,
  );
  opts.beginAudition({
    playheadSec: start,
    untilSec: end,
    skip: { start: opts.skipStart, end: opts.skipEnd },
  });
}

export function playAbRange(opts: {
  skipStart: number;
  skipEnd: number;
  padSec?: number;
  gapSec?: number;
  beginAudition: BeginAudition;
}): void {
  const { start, end } = paddedAuditionWindow(
    opts.skipStart,
    opts.skipEnd,
    opts.padSec,
  );
  opts.beginAudition({
    playheadSec: start,
    untilSec: end,
    abFollowup: {
      start,
      until: end,
      skipStart: opts.skipStart,
      skipEnd: opts.skipEnd,
      gapSec: opts.gapSec ?? DEFAULT_AB_GAP_SEC,
    },
  });
}
