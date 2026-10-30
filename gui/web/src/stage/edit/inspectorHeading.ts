import type { SystemIconName } from "../../system/icons";
import type { ProjectView, Selection } from "../../types/project";

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

/** The icon and name an object's Inspector wears. */
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
            : `${trackLabel(project, selection.trackId)} clip`,
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
    case "applied":
      return { icon: "scissors", name: "Cut" };
    case "chapter":
      return { icon: "flag", name: "Chapter" };
    case "social":
      return { icon: "send", name: "Social clip" };
    case "comment":
      return { icon: "message-square", name: "Comment" };
    case "bleedAttenuation":
      return { icon: "shield-check", name: "Auto reduction" };
    case "envelope":
    case "envelopePoint":
      return { icon: "volume-1", name: "Volume envelope" };
  }
}
