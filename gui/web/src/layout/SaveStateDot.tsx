import { useEffect, useSyncExternalStore } from "react";
import {
  selectRecoveryOutcome,
  useOfflineAttention,
} from "../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../state/documentSendOrder";
import { useDaw } from "../state/useDaw";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStateDotView } from "./SaveStateDotView";
import { saveStateOf } from "./saveState";

function focusAttention() {
  const banner = document.getElementById(ATTENTION_BANNER_ID);
  banner?.querySelector("details")?.setAttribute("open", "");
  banner?.focus();
}

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
  const latest = attention.conflicts.at(-1);
  const showsDismissedOutcome =
    latest?.dismissed &&
    ((state?.kind === "failed" &&
      state.cause === "refused" &&
      latest.kind === "refused" &&
      latest.reason === state.reason) ||
      (state?.kind === "unknown" &&
        latest.kind === "unknown" &&
        latest.reason === state.reason &&
        latest.recovery === state.recovery));

  useEffect(() => {
    if (attention.recoverySelection) {
      focusAttention();
    }
  }, [attention.recoverySelection]);

  if (!state) return null;
  return (
    <SaveStateDotView
      state={state}
      attention={
        state.kind === "failed" && !showsDismissedOutcome
          ? { kind: "passive" }
          : {
              kind: "button",
              activate: () => {
                if (projectPath && latest?.dismissed && showsDismissedOutcome) {
                  selectRecoveryOutcome(projectPath, latest);
                }
                focusAttention();
              },
            }
      }
    />
  );
}
