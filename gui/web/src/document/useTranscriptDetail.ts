import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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

export type TranscriptDetailView =
  | { kind: "hidden" }
  | { kind: "ready"; shown: ShownTranscript }
  | { kind: "pending"; retry: () => void }
  | { kind: "failed"; retry: () => void; recovering: boolean };

/** How long a held refresh may sit on one commit before it counts as lost. */
export const TRANSCRIPT_STALL_MS = 35_000;

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
  const [stalled, setStalled] = useState<{ key: string; run: number } | null>(
    null,
  );
  const [run, setRun] = useState(0);
  const { view, refreshKey, retry } = decide(inputs, observedSnapshot);
  useEffect(() => {
    if (refreshKey === null) return;
    const timer = window.setTimeout(
      () => setStalled({ key: refreshKey, run }),
      TRANSCRIPT_STALL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [refreshKey, run]);
  const retryStalled = useCallback(() => {
    setStalled(null);
    setRun((n) => n + 1);
    // A recovery that never answered is what held the commit: ask again first.
    if (documentAuthority.phase.kind === "recovering")
      void recoverDocument().catch(() => undefined);
    retry();
  }, [retry]);
  if (refreshKey !== null && stalled?.key === refreshKey && stalled.run === run)
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
