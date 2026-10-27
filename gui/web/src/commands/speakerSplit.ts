import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { splitSpeakersBlocker } from "../utils/speakerSplit";
import { registerCommand } from "./execute";

/** Opens Prepare at the track's split prompt; the card starts the job and owns its undo. */
export function registerSpeakerSplitCommands(): void {
  registerCommand("track.splitSpeakers", (args) => {
    const s = useDawStore.getState();
    const trackId =
      typeof args.trackId === "string" && args.trackId
        ? args.trackId
        : s.selection?.kind === "track"
          ? s.selection.trackId
          : null;
    const track = s.project?.tracks.find(
      (candidate) => candidate.id === trackId,
    );
    const blocker = splitSpeakersBlocker(
      track,
      canManageProjects(s.projectPath),
    );
    if (blocker || trackId == null) {
      return {
        status: "disabled",
        reason: blocker ?? "Select a track to split",
      };
    }
    s.setPrepareFocusTrackId(trackId);
    s.openStage("prepare");
    return { status: "ok" };
  });
}
