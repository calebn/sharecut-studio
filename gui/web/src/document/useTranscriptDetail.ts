import { useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { isShareProjectKey, readsTranscriptWords } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { documentAuthority, documentScope } from "./authorityState";
import { currentDocumentSeq } from "./cursor";
import {
  needsTranscriptDetailHydrate,
  retryTranscriptDetail,
  scheduleTranscriptDetailHydrate,
  subscribeTranscriptDetail,
  transcriptDetailSnapshot,
  transcriptDetailStateFor,
} from "./hydrateTranscriptDetail";
import {
  type ShownTranscript,
  shownTranscriptOf,
  transcriptGrantOf,
} from "./shownTranscript";

export type TranscriptDetailView =
  | { kind: "hidden" }
  | { kind: "ready"; shown: ShownTranscript }
  | { kind: "pending"; retry: () => void }
  | { kind: "failed"; retry: () => void; recovering: boolean };

export function useTranscriptDetail(): TranscriptDetailView {
  const { project, projectPath, shareTranscriptWords, shareCapabilities } =
    useDawStore(
      useShallow((state) => ({
        project: state.project,
        projectPath: state.projectPath,
        shareTranscriptWords: state.shareTranscriptWords,
        shareCapabilities: state.shareCapabilities,
      })),
    );
  const observedSnapshot = useSyncExternalStore(
    subscribeTranscriptDetail,
    transcriptDetailSnapshot,
  );
  if (!project) return { kind: "hidden" };

  const reads = readsTranscriptWords(projectPath, shareTranscriptWords);
  const incomplete = project.meta?.hydration?.transcript_words === false;
  if (incomplete && !reads) return { kind: "hidden" };
  const grant = transcriptGrantOf({
    projectPath,
    shareTranscriptWords,
    shareCapabilities,
  });
  const shown = (complete: boolean) =>
    shownTranscriptOf(
      project.transcript,
      documentAuthority.settled,
      grant,
      complete,
    );
  if (!needsTranscriptDetailHydrate(project, reads))
    return { kind: "ready", shown: shown(true) };

  const scope = documentScope();
  const seq = currentDocumentSeq();
  const token = documentAuthority.token;
  const current = transcriptDetailStateFor(projectPath, scope, seq, token);
  const pendingOrHeld = (retry: () => void): TranscriptDetailView => {
    if (!isShareProjectKey(projectPath)) return { kind: "pending", retry };
    const held = shown(false);
    return held.drawn
      ? { kind: "ready", shown: held }
      : { kind: "pending", retry };
  };
  const retryUntracked = () => {
    const state = useDawStore.getState();
    const now = documentScope();
    if (
      transcriptDetailSnapshot() !== observedSnapshot ||
      state.project !== project ||
      state.projectPath !== projectPath ||
      now.generation !== scope.generation ||
      currentDocumentSeq() !== seq ||
      documentAuthority.token !== token ||
      !needsTranscriptDetailHydrate(
        state.project,
        readsTranscriptWords(state.projectPath, state.shareTranscriptWords),
      )
    )
      return;
    scheduleTranscriptDetailHydrate(state.project);
  };
  if (current.kind === "pending") {
    return pendingOrHeld(() => retryTranscriptDetail(current.attempt));
  }
  if (current.kind === "failed") {
    return {
      kind: "failed",
      recovering: current.recovering,
      retry: () => retryTranscriptDetail(current.attempt),
    };
  }
  return pendingOrHeld(retryUntracked);
}
