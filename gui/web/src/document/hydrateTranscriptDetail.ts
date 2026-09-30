import { loadDocumentState } from "../api/project";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot } from "./applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "./authorityState";
import { currentDocumentSeq } from "./cursor";

let inflight: AbortController | null = null;

export function needsTranscriptDetailHydrate(
  _previous: ProjectView | null,
  next: ProjectView | null,
): boolean {
  if (!next) {
    return false;
  }
  if (isShareProjectKey(next.project_path)) {
    return false;
  }
  return next.meta?.hydration?.transcript_words === false;
}

/** Re-fetch DETAIL words after overlay leaves `transcript_words` incomplete. */
export function scheduleTranscriptDetailHydrate(
  previous: ProjectView | null,
  next: ProjectView | null,
): void {
  if (!needsTranscriptDetailHydrate(previous, next) || !next?.project_path) {
    return;
  }
  const path = useDawStore.getState().projectPath;
  if (isShareProjectKey(path)) return;
  const scope = activateDocumentScope(path);
  const seqAtStart = currentDocumentSeq();
  inflight?.abort();
  const ac = new AbortController();
  inflight = ac;
  void loadDocumentState(path, "detail", ac.signal)
    .then((detail) => {
      if (ac.signal.aborted || !isCurrentDocumentScope(scope)) return;
      if (
        currentDocumentSeq() !== seqAtStart ||
        detail.server_seq !== seqAtStart
      ) {
        scheduleTranscriptDetailHydrate(null, useDawStore.getState().project);
        return;
      }
      applyDocumentSnapshot(detail, { scope, hydrationSeq: seqAtStart });
    })
    .catch(() => undefined);
}
