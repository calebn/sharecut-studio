import { useMemo } from "react";
import { seekTransport } from "../../commands/seek";
import { useDawStore } from "../../state/dawStore";
import type { ChapterMarker } from "../../types/project";
import { chapterIndexAt, playerChapters, sortChapters } from "./playerModel";

const NONE: ChapterMarker[] = [];

/** The project's chapters in time order, the one the playhead is in, and the seek a row runs. */
export function usePlayerChapters() {
  const markers = useDawStore((s) => s.project?.chapters) ?? NONE;
  const duration = useDawStore((s) => s.project?.timeline_duration_sec ?? 0);
  const current = useDawStore((s) =>
    chapterIndexAt(sortChapters(s.project?.chapters ?? NONE), s.playheadSec),
  );
  const sorted = useMemo(() => sortChapters(markers), [markers]);
  const chapters = useMemo(
    () => playerChapters(sorted, duration),
    [sorted, duration],
  );
  return {
    chapters,
    current,
    seekTo: (index: number) => {
      const target = sorted[index];
      if (target) void seekTransport(target.time);
    },
  };
}
