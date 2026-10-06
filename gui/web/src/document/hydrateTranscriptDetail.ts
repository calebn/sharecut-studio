import { loadDocumentState } from "../api/project";
import { type RangeEditMode, rangeEditMode } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot } from "./applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "./authorityState";
import { currentDocumentSeq } from "./cursor";

let inflight: AbortController | null = null;

/** Timed words load only for sessions that can select a range from them. */
export function needsTranscriptDetailHydrate(
  next: ProjectView | null,
  mode: RangeEditMode,
): boolean {
  return mode !== "none" && next?.meta?.hydration?.transcript_words === false;
}

/** Re-fetch DETAIL words after overlay leaves `transcript_words` incomplete. */
export function scheduleTranscriptDetailHydrate(
  next: ProjectView | null,
): void {
  const { projectPath: path, shareCapabilities } = useDawStore.getState();
  if (
    !path ||
    !needsTranscriptDetailHydrate(next, rangeEditMode(path, shareCapabilities))
  ) {
    return;
  }
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
        scheduleTranscriptDetailHydrate(useDawStore.getState().project);
        return;
      }
      applyDocumentSnapshot(detail, { scope, hydrationSeq: seqAtStart });
    })
    .catch(() => undefined);
}
