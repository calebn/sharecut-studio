import type { ProjectView } from "../types/project";
import { trackIsAudible } from "../utils/audio";
import type { WordTarget } from "../utils/rangeSelect";
import { isWordActive } from "../utils/transcript";

type Listening = {
  viewerMute: Record<string, boolean>;
  soloTracks: Record<string, boolean>;
};

/**
 * The word the playhead is in, else the last audible word that started before it. The
 * targeted tracks are tried first, then the project's tracks top down; a muted
 * or unsoloed track is never chosen.
 */
export function wordUnderPlayhead(
  project: ProjectView,
  playheadSec: number,
  targetTrackIds: readonly string[] | null,
  { viewerMute, soloTracks }: Listening,
): (WordTarget & { text: string }) | null {
  const order = [
    ...(targetTrackIds ?? []),
    ...project.tracks
      .filter((t) => trackIsAudible(t.id, t.muted, viewerMute, soloTracks))
      .map((t) => t.id),
  ];
  for (const trackId of new Set(order)) {
    let started: (WordTarget & { text: string }) | null = null;
    let startedAt = Number.NEGATIVE_INFINITY;
    for (const u of project.transcript?.utterances ?? []) {
      if (u.track_id !== trackId) continue;
      for (const w of u.words ?? []) {
        if (w.word_index == null || w.timeline_start == null) continue;
        if (w.suppressed || w.ignored) continue;
        const word = {
          trackId,
          sourceId: u.source_id ?? null,
          wordIndex: w.word_index,
          text: w.text,
        };
        if (isWordActive(w, playheadSec)) return word;
        if (
          w.mappable !== false &&
          w.timeline_start <= playheadSec &&
          w.timeline_start >= startedAt
        ) {
          started = word;
          startedAt = w.timeline_start;
        }
      }
    }
    if (started) return started;
  }
  return null;
}
