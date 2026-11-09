import { setTrackMetaCommand } from "../api";
import { redisplayDrafts } from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { useDawStore } from "../state/dawStore";

export type TrackMetaFields = {
  label?: string;
  role?: string;
  speaker?: string;
};

export async function sendTrackMeta(
  trackId: string,
  fields: TrackMetaFields,
): Promise<void> {
  const state = useDawStore.getState();
  const previous = state.projectEditBasis();
  const path = state.projectPath;
  if (!previous) throw new Error("The project is not open.");
  const seqAtStart = currentDocumentSeq();
  const sending = setTrackMetaCommand(path, trackId, fields);
  redisplayDrafts();
  const optimistic = useDawStore.getState().project;
  try {
    const result = await sending;
    if (result.queued && useDawStore.getState().projectPath === path) {
      useDawStore
        .getState()
        .announceStatus("Track metadata change queued. Still sending.");
    }
  } catch (error) {
    if (optimistic) {
      revertOptimisticIfUnchanged(previous, seqAtStart, path, optimistic);
    }
    throw error;
  }
}
