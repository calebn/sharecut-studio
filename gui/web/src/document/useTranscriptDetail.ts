import { useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { readsTranscriptWords } from "../shareMode";
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

export type TranscriptDetailView =
  | { kind: "hidden" }
  | { kind: "ready" }
  | { kind: "pending"; retry: () => void }
  | { kind: "failed"; retry: () => void; recovering: boolean };

export function useTranscriptDetail(): TranscriptDetailView {
  const { project, projectPath, shareTranscriptWords } = useDawStore(
    useShallow((state) => ({
      project: state.project,
      projectPath: state.projectPath,
      shareTranscriptWords: state.shareTranscriptWords,
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
  if (!needsTranscriptDetailHydrate(project, reads)) return { kind: "ready" };

  const scope = documentScope();
  const seq = currentDocumentSeq();
  const token = documentAuthority.token;
  const current = transcriptDetailStateFor(projectPath, scope, seq, token);
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
    return {
      kind: "pending",
      retry: () => retryTranscriptDetail(current.attempt),
    };
  }
  if (current.kind === "failed") {
    return {
      kind: "failed",
      recovering: current.recovering,
      retry: () => retryTranscriptDetail(current.attempt),
    };
  }
  return { kind: "pending", retry: retryUntracked };
}
