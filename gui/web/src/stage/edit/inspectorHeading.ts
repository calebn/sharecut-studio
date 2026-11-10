import { seamById } from "../../edit/seam";
import type { SystemIconName } from "../../system/icons";
import type { PersonData } from "../../system/Person";
import { laneColorIndex } from "../../timeline/laneColors";
import type { ProjectView, Selection, TrackView } from "../../types/project";
import {
  clipIdentityTrack,
  clipLabels,
  clipSpeakerLabel,
} from "../../utils/clipLabels";
import { sortedVolumePoints } from "../../utils/envelopes";
import { inspectorRename } from "./inspectorRename";
import { kindOf } from "./trackKind";
import { episodePeople, personId } from "./trackPeople";

export interface InspectorHeading {
  icon: SystemIconName;
  mark?: PersonData;
  name: string;
  onRename?: (name: string) => void;
}

const RANGE: InspectorHeading = {
  icon: "between-horizontal-start",
  name: "Range",
};

/**
 * A voice track wears its person's colour, the one the Person picker shows;
 * any other track, or a voice track nobody speaks on, wears its lane colour.
 */
function trackMarkColorIndex(
  project: ProjectView,
  track: TrackView,
  index: number,
): number {
  const person =
    kindOf(track.role) === "voice"
      ? episodePeople(project.tracks).find(
          (p) => p.id === personId(track.speaker),
        )
      : undefined;
  return person?.colorIndex ?? laneColorIndex(track.role, index);
}

const trackLabel = (project: ProjectView | null, trackId: string) =>
  project?.tracks.find((track) => track.id === trackId)?.label || trackId;

function clipName(
  project: ProjectView | null,
  clipId: string,
  trackId: string,
): string {
  const clip = Object.values(project?.clips.tracks ?? {})
    .flat()
    .find((c) => c.id === clipId);
  if (!clip || !project) return `${trackLabel(project, trackId)} clip`;
  const identity = clipIdentityTrack({ clip, tracks: project.tracks });
  const labels = clipLabels({
    clip,
    trackSpeaker: identity?.speaker,
    trackLabel: identity?.label,
    role: identity?.role ?? "audio",
  });
  return `${labels.speaker} · ${labels.start} to ${labels.end}`;
}

/**
 * The name the phone dock shows beside the object's icon (max 96 px): a clip is
 * its speaker, the rest keep the heading's name.
 */
export function inspectorShortName(
  selection: Selection,
  project: ProjectView | null,
): string {
  if (selection?.kind === "clip" && (selection.ids?.length ?? 1) === 1) {
    const clip = Object.values(project?.clips.tracks ?? {})
      .flat()
      .find((c) => c.id === selection.id);
    const identity =
      clip && project
        ? clipIdentityTrack({ clip, tracks: project.tracks })
        : undefined;
    if (clip && project)
      return clipSpeakerLabel({
        trackSpeaker: identity?.speaker,
        trackLabel: identity?.label,
        role: identity?.role ?? "audio",
      });
  }
  return inspectorHeading(selection, project).name;
}

export function inspectorHeading(
  selection: Selection,
  project: ProjectView | null,
): InspectorHeading {
  switch (selection?.kind) {
    case undefined:
    case "range":
      return RANGE;
    case "clip": {
      const count = selection.ids?.length ?? 1;
      return {
        icon: "sliders-horizontal",
        name:
          count > 1
            ? `${count} clips`
            : clipName(project, selection.id, selection.trackId),
      };
    }
    case "track": {
      const count = selection.trackIds?.length ?? 1;
      if (count > 1) return { icon: "volume-1", name: `${count} tracks` };
      const index =
        project?.tracks.findIndex((t) => t.id === selection.trackId) ?? -1;
      const track = project?.tracks[index];
      const name = trackLabel(project, selection.trackId);
      return {
        icon: "volume-1",
        name,
        ...(track
          ? {
              mark: {
                name,
                colorIndex: trackMarkColorIndex(project, track, index),
              },
            }
          : {}),
        onRename: inspectorRename(selection, project),
      };
    }
    case "transcriptRange":
      return {
        icon: "text-cursor-input",
        name:
          selection.startWordIndex === selection.endWordIndex
            ? "Word"
            : "Words",
      };
    case "pending":
      return { icon: "wand-sparkles", name: "Suggestion" };
    case "seam": {
      const seam = project ? seamById(project, selection.id) : null;
      return seam?.kind === "split"
        ? { icon: "split", name: "Split" }
        : { icon: "scissors", name: "Cut" };
    }
    case "chapter":
      return { icon: "flag", name: "Chapter" };
    case "social":
      return { icon: "send", name: "Social clip" };
    case "comment":
      return { icon: "message-square", name: "Comment" };
    case "bleedAttenuation":
      return { icon: "shield-check", name: "Auto reduction" };
    case "envelope":
      return { icon: "volume-1", name: trackLabel(project, selection.trackId) };
    case "envelopePoint": {
      const index = sortedVolumePoints(
        project?.envelopes,
        selection.trackId,
      ).findIndex((point) => point.id === selection.pointId);
      return {
        icon: "volume-1",
        name: `${trackLabel(project, selection.trackId)} point${index < 0 ? "" : ` ${index + 1}`}`,
      };
    }
  }
}
