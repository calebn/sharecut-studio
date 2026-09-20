import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { currentDocumentSeq } from "./cursor";

/** Revert an optimistic splice only when hub seq has not already advanced. */
export function revertOptimisticIfUnchanged(
  previous: ProjectView,
  seqAtStart: number,
): void {
  if (currentDocumentSeq() > seqAtStart) {
    return;
  }
  useDawStore.getState().setProject(previous);
}
