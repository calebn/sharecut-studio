import type { OverviewTick } from "../../system/OverviewStrip";
import type { HearMode, PlayerChapter } from "../../system/Player";
import type { ChapterMarker } from "../../types/project";
import type { AuditionMode } from "../../types/session";
import { formatTimeShort } from "../../utils/time";

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

/** The edited-length delta the Cuts pill shows, e.g. `−4:10`; nothing when no cut has been applied. */
export function cutsLabel(removedSec: number): string | undefined {
  return removedSec > 0.5 ? `−${formatTimeShort(removedSec)}` : undefined;
}

export function playerChapters(
  chapters: readonly ChapterMarker[],
  durationSec: number,
): PlayerChapter[] {
  return [...chapters]
    .sort((a, b) => a.time - b.time)
    .map((chapter) => ({
      title: chapter.title,
      time: formatTimeShort(chapter.time),
      at: durationSec > 0 ? chapter.time / durationSec : 0,
    }));
}

/** The chapter the playhead is in: the last one that has started. */
export function chapterIndexAt(
  chapters: readonly ChapterMarker[],
  playheadSec: number,
): number | undefined {
  const sorted = [...chapters].sort((a, b) => a.time - b.time);
  let found: number | undefined;
  sorted.forEach((chapter, index) => {
    if (chapter.time <= playheadSec) found = index;
  });
  return found;
}

export function playerTicks(
  chapters: readonly PlayerChapter[],
  commentTimes: readonly number[],
  durationSec: number,
): OverviewTick[] {
  const comments: OverviewTick[] =
    durationSec > 0
      ? commentTimes.map((time) => ({
          at: Math.min(1, Math.max(0, time / durationSec)),
          kind: "comment",
        }))
      : [];
  return [
    ...chapters.map((chapter) => ({
      at: chapter.at,
      kind: "chapter" as const,
    })),
    ...comments,
  ];
}
