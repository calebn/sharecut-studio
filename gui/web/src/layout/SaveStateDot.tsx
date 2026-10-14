import { useSyncExternalStore } from "react";
import { isShareProjectKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../state/documentSendOrder";
import { useOfflineAttention } from "../state/offlineAttention";
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
          refusals: attention.conflicts.map((c) => c.reason),
          unreadable:
            attention.status === "unreadable" ||
            attention.status === "retrying",
          loaded: attention.loaded,
          settling: attention.settling,
        });

  if (!state) return null;
  return (
    <SaveStateDotView
      state={state}
      onShowAttention={() =>
        document.getElementById(ATTENTION_BANNER_ID)?.focus()
      }
    />
  );
}
