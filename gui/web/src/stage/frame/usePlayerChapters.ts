import { useMemo } from "react";
import { episodeDurationSec } from "../../audio/proxyMath";
import { seekTransport } from "../../commands/seek";
import { useDawStore } from "../../state/dawStore";
import type { ChapterMarker } from "../../types/project";
import { chapterIndexAt, playerChapters, sortChapters } from "./playerModel";

const NONE: ChapterMarker[] = [];

export function usePlayerChapters() {
  const markers = useDawStore((s) => s.project?.chapters) ?? NONE;
  const duration = useDawStore((s) => episodeDurationSec(s.project));
  const sorted = useMemo(() => sortChapters(markers), [markers]);
  const current = useDawStore((s) => chapterIndexAt(sorted, s.playheadSec));
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
