import type { OverviewTick } from "../../system/OverviewStrip";
import type { HearMode, PlayerChapter } from "../../system/Player";
import { formatSpan, hasCutsSaved } from "../../system/seconds";
import type { ChapterMarker } from "../../types/project";
import type { AuditionMode } from "../../types/session";
import { clampToSession, formatTimeShort } from "../../utils/time";

const HEAR_FOR_AUDITION: Record<AuditionMode, HearMode> = {
  mix: "mix",
  fx: "edited",
  raw: "original",
};

const AUDITION_FOR_HEAR: Record<HearMode, AuditionMode> = {
  mix: "mix",
  edited: "fx",
  original: "raw",
};

export function hearModeOf(mode: AuditionMode): HearMode {
  return HEAR_FOR_AUDITION[mode];
}

export function auditionOf(mode: HearMode): AuditionMode {
  return AUDITION_FOR_HEAR[mode];
}

/** The edited-length delta the Cuts pill shows, e.g. `−4 min 10 s`; nothing when no cut has been applied. */
export function cutsLabel(removedSec: number): string | undefined {
  return hasCutsSaved(removedSec) ? `−${formatSpan(removedSec)}` : undefined;
}

/** Chapters by time. The Player's chapter indexes are positions in this order. */
export function sortChapters(
  chapters: readonly ChapterMarker[],
): ChapterMarker[] {
  return [...chapters].sort((a, b) => a.time - b.time);
}

/** The Player's chapters for markers already in `sortChapters` order. */
export function playerChapters(
  sorted: readonly ChapterMarker[],
  durationSec: number,
): PlayerChapter[] {
  return sorted.map((chapter) => {
    const time =
      durationSec > 0
        ? clampToSession(chapter.time, durationSec)
        : chapter.time;
    return {
      title: chapter.title,
      time: formatTimeShort(time),
      at: durationSec > 0 ? time / durationSec : 0,
    };
  });
}

/** The chapter the playhead is in: the last one that has started. */
export function chapterIndexAt(
  sorted: readonly ChapterMarker[],
  playheadSec: number,
): number | undefined {
  const index = sorted.findLastIndex((chapter) => chapter.time <= playheadSec);
  return index < 0 ? undefined : index;
}

export function playerTicks(
  chapters: readonly PlayerChapter[],
  commentTimes: readonly number[],
  durationSec: number,
  suggestionTimes: readonly number[] = [],
): OverviewTick[] {
  const at = (time: number) => Math.min(1, Math.max(0, time / durationSec));
  const comments: OverviewTick[] =
    durationSec > 0
      ? commentTimes.map((time) => ({ at: at(time), kind: "comment" }))
      : [];
  // Clamp before deduping so two times past the end share one tick (and key).
  const suggestions: OverviewTick[] =
    durationSec > 0
      ? [...new Set(suggestionTimes.map(at))].map((a) => ({
          at: a,
          kind: "suggestion",
        }))
      : [];
  return [
    ...[...new Set(chapters.map((chapter) => chapter.at))].map((at) => ({
      at,
      kind: "chapter" as const,
    })),
    ...comments,
    ...suggestions,
  ];
}
