import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { currentDocumentSeq } from "./cursor";

export function revertOptimisticIfUnchanged(
  previous: ProjectView,
  seqAtStart: number,
  projectPath: string,
  optimistic: ProjectView,
): void {
  const state = useDawStore.getState();
  if (
    state.projectPath !== projectPath ||
    state.project !== optimistic ||
    currentDocumentSeq() > seqAtStart
  ) {
    return;
  }
  state.setProject(previous);
}
