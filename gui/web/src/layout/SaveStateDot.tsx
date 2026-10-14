import { useLayoutEffect, useSyncExternalStore } from "react";
import { isShareProjectKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../state/documentSendOrder";
import {
  selectRecoveryOutcome,
  useOfflineAttention,
} from "../state/offlineAttention";
import { useDaw } from "../state/useDaw";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStateDotView } from "./SaveStateDotView";
import { saveStateOf } from "./saveState";

/**
 * The host's project save state as a status light, from the sends this tab has in flight and the
 * offline queue and conflicts the Needs attention banner lists. Share guests
 * see none: their edits go through the review link.
 */
export function SaveStateDot() {
  const projectPath = useDaw((s) => s.projectPath);
  const guest = isShareProjectKey(projectPath);
  const busy = useSyncExternalStore(subscribeDocumentActivity, () =>
    documentActivityBusy(projectPath),
  );
  const attention = useOfflineAttention(
    guest || !projectPath ? null : projectPath,
  );
  const state =
    guest || !projectPath
      ? null
      : saveStateOf({
          busy,
          pending: attention.pending,
          conflicts: attention.conflicts,
          unreadable:
            attention.status === "unreadable" ||
            attention.status === "retrying",
          loaded: attention.loaded,
          settling: attention.settling,
        });

  useLayoutEffect(() => {
    if (attention.recoverySelection) {
      document.getElementById(ATTENTION_BANNER_ID)?.focus();
    }
  }, [attention.recoverySelection]);

  if (!state) return null;
  return (
    <SaveStateDotView
      state={state}
      onShowAttention={() => {
        const latest = attention.conflicts.at(-1);
        const showsDismissedOutcome =
          latest?.dismissed &&
          ((state.kind === "failed" &&
            state.cause === "refused" &&
            latest.kind === "refused" &&
            latest.reason === state.reason) ||
            (state.kind === "unknown" &&
              latest.kind === "unknown" &&
              latest.reason === state.reason &&
              latest.recovery === state.recovery));
        if (
          projectPath &&
          latest?.dismissed &&
          showsDismissedOutcome &&
          selectRecoveryOutcome(projectPath, latest)
        ) {
          return;
        }
        document.getElementById(ATTENTION_BANNER_ID)?.focus();
      }}
    />
  );
}
