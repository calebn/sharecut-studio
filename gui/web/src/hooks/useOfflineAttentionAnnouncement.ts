import { useEffect, useRef } from "react";
import { attentionRegionLabel } from "../layout/attentionLabel";
import type { AttentionStatus } from "../services/offlineQueue/offlineAttention";
import { useDawStore } from "../state/dawStore";

type Input = {
  projectPath: string;
  pending: number;
  conflictCount: number;
  unreadable: boolean;
  dismissFailed: boolean;
  loaded: boolean;
  status: AttentionStatus;
};

function attentionAnnouncement(input: Input): string | null {
  const visible =
    input.unreadable || input.conflictCount > 0 || input.pending > 0;
  if (!visible) return null;
  if (!input.loaded && !input.unreadable && input.status !== "dismiss-failed") {
    return null;
  }
  if (input.status === "checking" || input.status === "dismissing") {
    return null;
  }
  return attentionRegionLabel({
    pending: input.pending,
    conflictCount: input.conflictCount,
    unreadable: input.unreadable,
    dismissFailed: input.dismissFailed,
  });
}

/**
 * Speaks the Needs-attention summary through the app's one live region when
 * it changes. A summary that goes away and comes back is spoken again; one
 * that only waits on a check is not.
 */
export function useOfflineAttentionAnnouncement(input: Input): void {
  const { projectPath, unreadable, loaded, status } = input;
  const spoken = useRef({ projectPath: "", message: "" });
  const message = attentionAnnouncement(input);

  useEffect(() => {
    if (spoken.current.projectPath !== projectPath) {
      spoken.current = { projectPath, message: "" };
    }
    if (message) {
      if (message !== spoken.current.message) {
        spoken.current.message = message;
        useDawStore.getState().announceStatus(message, { toast: false });
      }
    } else if (
      status !== "checking" &&
      status !== "dismissing" &&
      !(unreadable && !loaded)
    ) {
      spoken.current.message = "";
    }
  }, [projectPath, message, status, unreadable, loaded]);
}
