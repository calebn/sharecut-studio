import { useEffect, useRef, useSyncExternalStore } from "react";
import { isShareProjectKey } from "../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../state/documentSendOrder";
import { requestHostDrain } from "../state/drainOfflineQueue";
import {
  refreshOfflineAttention,
  useOfflineAttention,
} from "../state/offlineAttention";
import { useDaw } from "../state/useDaw";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStatePillView } from "./SaveStatePillView";
import {
  type SaveState,
  saveStateAnnouncement,
  saveStateOf,
} from "./saveState";

/**
 * The host's project save state, from the sends this tab has in flight and the
 * offline queue and conflicts the Needs attention banner lists. Share guests
 * see none: their edits go through the review link.
 */
export function SaveStatePill() {
  const { projectPath, announceStatus } = useDaw((s) => ({
    projectPath: s.projectPath,
    announceStatus: s.announceStatus,
  }));
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
        });

  const previous = useRef<SaveState | null>(null);
  useEffect(() => {
    const line = saveStateAnnouncement(previous.current, state);
    previous.current = state;
    if (line) announceStatus(line, { toast: false });
  });

  if (!state) return null;
  return (
    <SaveStatePillView
      state={state}
      onSendNow={() => {
        void requestHostDrain(projectPath);
      }}
      onSeeWhy={() => document.getElementById(ATTENTION_BANNER_ID)?.focus()}
      onRetry={() => refreshOfflineAttention(projectPath)}
    />
  );
}
