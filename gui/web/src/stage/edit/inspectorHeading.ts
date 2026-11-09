import { seamById } from "../../edit/seam";
import type { SystemIconName } from "../../system/icons";
import type { ProjectView, Selection } from "../../types/project";
import {
  clipIdentityTrack,
  clipLabels,
  clipSpeakerLabel,
} from "../../utils/clipLabels";
import { sortedVolumePoints } from "../../utils/envelopes";

export interface InspectorHeading {
  icon: SystemIconName;
  name: string;
}

const RANGE: InspectorHeading = {
  icon: "between-horizontal-start",
  name: "Range",
};

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
      return {
        icon: "volume-1",
        name:
          count > 1
            ? `${count} tracks`
            : trackLabel(project, selection.trackId),
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
