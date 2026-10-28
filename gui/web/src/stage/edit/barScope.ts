import type { EditFacts } from "../../edit/editSelection";
import type { ScopeTrack } from "../../system/ScopeChip";
import { laneColor } from "../../timeline/laneColors";
import type { ProjectView } from "../../types/project";
import { dialogueTrackIds } from "../../utils/bladeTracks";

/** The tracks the selection covers, in project order, each with its lane colour. */
export function scopeOf(
  facts: EditFacts,
  project: ProjectView,
): { tracks: ScopeTrack[]; all: boolean } {
  const ids = new Set(facts.span?.trackIds ?? []);
  const dialogue = new Set(dialogueTrackIds(project.tracks));
  const tracks: ScopeTrack[] = [];
  project.tracks.forEach((track, index) => {
    if (ids.has(track.id))
      tracks.push({
        id: track.id,
        name: track.label || track.id,
        color: laneColor(track.role, index),
      });
  });
  const covered = [...dialogue].every((id) => ids.has(id));
  return { tracks, all: dialogue.size > 0 && covered };
}
