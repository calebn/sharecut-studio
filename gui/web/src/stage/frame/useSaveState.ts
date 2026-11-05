import { useEffect } from "react";
import { executePointerCommand } from "../../commands/pointer";
import {
  OPEN_REVIEW_ATTENTION_EVENT,
  REVIEW_ATTENTION_ID,
} from "../../review/reviewQueueModel";
import {
  refreshOfflineAttention,
  selectRecoveryOutcome,
  useOfflineAttention,
} from "../../services/offlineQueue/offlineAttention";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { useDocumentBusy } from "../../state/useDocumentBusy";
import { latestSaveOutcome, type SaveState, saveStateOf } from "./saveState";

export type SaveAttention =
  | { kind: "passive" }
  | { kind: "button"; activate: () => void };

const FOCUS_FRAMES = 30;

function focusWhenMounted(id: string, frames = FOCUS_FRAMES) {
  const target = document.getElementById(id);
  if (target) target.focus();
  else if (frames > 0) {
    // On a phone the group sits in the queue sheet, which the stage opens on this request.
    window.dispatchEvent(new Event(OPEN_REVIEW_ATTENTION_EVENT));
    requestAnimationFrame(() => focusWhenMounted(id, frames - 1));
  }
}

/** Opens Review and focuses the Needs attention group, where every attention row lives. */
function focusAttention() {
  void executePointerCommand("stage.review").then(() =>
    focusWhenMounted(REVIEW_ATTENTION_ID),
  );
}

/**
 * The project's save state from the sends this tab has in flight and the
 * offline queue and conflicts the Needs attention rows list. A share guest's
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
