import type { ProjectView } from "../types/project";
import { trackIsAudible } from "../utils/audio";
import type { WordTarget } from "../utils/rangeSelect";
import { isWordActive } from "../utils/transcript";

type Listening = {
  viewerMute: Record<string, boolean>;
  soloTracks: Record<string, boolean>;
};

export const WORD_GRACE_SEC = 1;

/**
 * The word the playhead is in, searched across every audible track before any
 * fallback; failing that, the word that ended most recently, no more than WORD_GRACE_SEC
 * before the playhead. The targeted tracks come first, then the project's tracks
 * top down; a muted or unsoloed track is never chosen. Suppressed and ignored
 * words are skipped, so a playhead inside one selects nothing from it and may
 * land on the nearest word that is still audible.
 */
export function wordUnderPlayhead(
  project: ProjectView,
  playheadSec: number,
  targetTrackIds: readonly string[] | null,
  { viewerMute, soloTracks }: Listening,
): (WordTarget & { text: string }) | null {
  const audible = (id: string, muted: boolean) =>
    trackIsAudible(id, muted, viewerMute, soloTracks);
  const mutedById = new Map(project.tracks.map((t) => [t.id, t.muted]));
  const order = [
    ...new Set([
      ...(targetTrackIds ?? []).filter((id) =>
        audible(id, mutedById.get(id) ?? false),
      ),
      ...project.tracks.filter((t) => audible(t.id, t.muted)).map((t) => t.id),
    ]),
  ];
  const utterances = project.transcript?.utterances ?? [];
  let recent: (WordTarget & { text: string }) | null = null;
  let recentEnd = Number.NEGATIVE_INFINITY;
  for (const trackId of order) {
    for (const u of utterances) {
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
        const end = w.timeline_end ?? w.timeline_start;
        if (
          w.mappable !== false &&
          end <= playheadSec &&
          playheadSec - end <= WORD_GRACE_SEC &&
          end > recentEnd
        ) {
          recent = word;
          recentEnd = end;
        }
      }
    }
  }
  return recent;
}
