import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { isShareProjectKey, readsTranscriptWords } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { recoverDocument } from "./applyDocumentUpdate";
import { documentAuthority, documentScope } from "./authorityState";
import { currentDocumentSeq } from "./cursor";
import {
  needsTranscriptDetailHydrate,
  retryTranscriptDetail,
  scheduleTranscriptDetailHydrate,
  subscribeTranscriptDetail,
  type TranscriptDetailSnapshot,
  transcriptDetailSnapshot,
  transcriptDetailStateFor,
} from "./hydrateTranscriptDetail";
import {
  type ShownTranscript,
  shownTranscriptOf,
  transcriptGrantOf,
} from "./shownTranscript";
import {
  restartTranscriptStall,
  useTranscriptStalled,
  watchTranscriptStall,
} from "./transcriptStall";

export type TranscriptDetailView =
  | { kind: "hidden" }
  | { kind: "ready"; shown: ShownTranscript }
  | { kind: "pending"; retry: () => void }
  | { kind: "failed"; retry: () => void; recovering: boolean };

type Inputs = Pick<
  ReturnType<typeof useDawStore.getState>,
  "project" | "projectPath" | "shareTranscriptWords" | "shareCapabilities"
>;
type Decision = {
  view: TranscriptDetailView;
  /** Set while a guest is drawing remembered words over a refresh. */
  refreshKey: string | null;
  retry: () => void;
};

export function useTranscriptDetail(): TranscriptDetailView {
  const inputs = useDawStore(
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
  const { view, refreshKey, retry } = decide(inputs, observedSnapshot);
  const stalled = useTranscriptStalled(refreshKey);
  useEffect(() => {
    if (refreshKey !== null) return watchTranscriptStall(refreshKey);
  }, [refreshKey]);
  const retryStalled = useCallback(() => {
    if (refreshKey !== null) restartTranscriptStall(refreshKey);
    // A recovery that never answered is what held the commit: ask again first.
    // One that is still running is joined, not restarted.
    if (documentAuthority.phase.kind === "recovering")
      void recoverDocument().catch(() => undefined);
    retry();
  }, [refreshKey, retry]);
  if (stalled)
    return { kind: "failed", recovering: false, retry: retryStalled };
  return view;
}

function decide(
  { project, projectPath, shareTranscriptWords, shareCapabilities }: Inputs,
  observedSnapshot: TranscriptDetailSnapshot,
): Decision {
  const none = (view: TranscriptDetailView): Decision => ({
    view,
    refreshKey: null,
    retry: () => undefined,
  });
  if (!project) return none({ kind: "hidden" });
  const reads = readsTranscriptWords(projectPath, shareTranscriptWords);
  const incomplete = project.meta?.hydration?.transcript_words === false;
  if (incomplete && !reads) return none({ kind: "hidden" });
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
    return none({ kind: "ready", shown: shown(true) });

  const scope = documentScope();
  const seq = currentDocumentSeq();
  const token = documentAuthority.token;
  const current = transcriptDetailStateFor(projectPath, scope, seq, token);
  const pendingOrHeld = (retry: () => void): Decision => {
    if (!isShareProjectKey(projectPath))
      return { view: { kind: "pending", retry }, refreshKey: null, retry };
    const held = shown(false);
    return held.drawn
      ? {
          view: { kind: "ready", shown: held },
          refreshKey: `${projectPath}|${seq}|${token}`,
          retry,
        }
      : { view: { kind: "pending", retry }, refreshKey: null, retry };
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
    return none({
      kind: "failed",
      recovering: current.recovering,
      retry: () => retryTranscriptDetail(current.attempt),
    });
  }
  return pendingOrHeld(retryUntracked);
}
