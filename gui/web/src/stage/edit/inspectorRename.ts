import { sendTrackMeta } from "../../hooks/trackMeta";
import { canIngestMedia } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import type { ProjectView, Selection } from "../../types/project";
import { errorMessage } from "../../utils/apiError";

type Rename = (name: string) => void;

function renameTrack(
  selection: Extract<Selection, { kind: "track" }>,
  project: ProjectView | null,
): Rename | undefined {
  if ((selection.trackIds?.length ?? 1) > 1) return undefined;
  if (!project?.tracks.some((track) => track.id === selection.trackId))
    return undefined;
  const { projectPath, guestMode, shareCapabilities } = useDawStore.getState();
  if (!canIngestMedia(projectPath, guestMode, shareCapabilities))
    return undefined;
  return (name) => {
    void sendTrackMeta(selection.trackId, { label: name }).catch((error) => {
      useDawStore
        .getState()
        .announceStatus(`Could not rename the track: ${errorMessage(error)}`, {
          tone: "error",
        });
    });
  };
}

export function inspectorRename(
  selection: Selection,
  project: ProjectView | null,
): Rename | undefined {
  return selection?.kind === "track"
    ? renameTrack(selection, project)
    : undefined;
}
