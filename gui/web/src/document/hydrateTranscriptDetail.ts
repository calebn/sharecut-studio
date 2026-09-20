import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { currentDocumentSeq } from "./cursor";
import { mergeProjectPatch } from "./projectPatch";

let inflight: AbortController | null = null;

export function needsTranscriptDetailHydrate(
  previous: ProjectView | null,
  next: ProjectView | null,
): boolean {
  if (!previous || !next) {
    return false;
  }
  if (isShareProjectKey(next.project_path)) {
    return false;
  }
  return (
    previous.meta?.hydration?.transcript_words === true &&
    next.meta?.hydration?.transcript_words === false
  );
}

/** Re-fetch DETAIL words after overlay leaves `transcript_words` incomplete. */
export function scheduleTranscriptDetailHydrate(
  previous: ProjectView | null,
  next: ProjectView | null,
): void {
  if (!needsTranscriptDetailHydrate(previous, next) || !next?.project_path) {
    return;
  }
  const path = next.project_path;
  const seqAtStart = currentDocumentSeq();
  inflight?.abort();
  const ac = new AbortController();
  inflight = ac;
  void import("../api")
    .then(({ loadProjectDetail }) =>
      loadProjectDetail(path, { signal: ac.signal }),
    )
    .then((detail) => {
      if (ac.signal.aborted || currentDocumentSeq() !== seqAtStart) {
        return;
      }
      useDawStore.setState((state) => {
        if (!state.project) {
          return state;
        }
        return { project: mergeProjectPatch(state.project, detail) };
      });
    })
    .catch(() => undefined);
}
