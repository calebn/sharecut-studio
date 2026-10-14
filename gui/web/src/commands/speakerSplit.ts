import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { splitSpeakersBlocker } from "../utils/speakerSplit";
import { registerCommand } from "./execute";

/** Opens the Split speakers dialog; the dialog starts the job and owns its undo. */
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
    const review = s.splitSpeakersReview;
    if (
      trackId != null &&
      track != null &&
      review?.trackId === trackId &&
      review.splitId === track.speaker_split_id &&
      review.historyHeadId === s.project?.history?.head_id
    ) {
      s.setSplitSpeakersTrackId(trackId);
      return { status: "ok" };
    }
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
    s.setSplitSpeakersTrackId(trackId);
    return { status: "ok" };
  });
}
