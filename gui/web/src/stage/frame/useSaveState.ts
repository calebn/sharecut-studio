import { useEffect } from "react";
import {
  refreshOfflineAttention,
  selectRecoveryOutcome,
  useOfflineAttention,
} from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { useDocumentBusy } from "../../state/useDocumentBusy";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { latestSaveOutcome, type SaveState, saveStateOf } from "./saveState";

export type SaveAttention =
  | { kind: "passive" }
  | { kind: "button"; activate: () => void };

function focusAttention() {
  const banner = document.getElementById(ATTENTION_BANNER_ID);
  banner?.querySelector("details")?.setAttribute("open", "");
  banner?.focus();
}

/**
 * The project's save state from the sends this tab has in flight and the
 * offline queue and conflicts the Needs attention banner lists. A share guest's
 * queue is the edits waiting to reach the host; a guest reading the saved copy
 * is unreachable.
 */
export function useSaveState(): {
  state: SaveState | null;
  attention: SaveAttention;
} {
  const projectPath = useDaw((s) => s.projectPath);
  const guest = isShareProjectKey(projectPath);
  const unreachable = useDaw((s) => guest && s.shareCapabilities === null);
  const busy = useDocumentBusy(projectPath);
  const attention = useOfflineAttention(projectPath || null);
  const state = !projectPath
    ? null
    : saveStateOf({
        busy,
        pending: attention.pending,
        conflicts: attention.conflicts,
        unreachable,
        unreadable:
          attention.status === "unreadable" || attention.status === "retrying",
        loaded: attention.loaded,
        settling: attention.settling,
      });
  const latest = latestSaveOutcome(attention.conflicts);
  const showsDismissedOutcome = latest?.dismissed && latest.kind === "unknown";

  useEffect(() => {
    if (attention.recoverySelection) {
      focusAttention();
    }
  }, [attention.recoverySelection]);

  return {
    state,
    attention:
      state?.kind === "failed" && state.cause === "unreadable"
        ? guest && projectPath
          ? {
              kind: "button",
              activate: () => refreshOfflineAttention(projectPath),
            }
          : { kind: "passive" }
        : {
            kind: "button",
            activate: () => {
              if (projectPath && latest && showsDismissedOutcome) {
                selectRecoveryOutcome(projectPath, latest);
              }
              focusAttention();
            },
          },
  };
}
