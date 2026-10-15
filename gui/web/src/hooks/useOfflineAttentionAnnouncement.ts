import { useEffect, useRef } from "react";
import { attentionRegionLabel } from "../layout/attentionLabel";
import type { AttentionStatus } from "../state/offlineAttention";
import { useDaw } from "../state/useDaw";

type Input = {
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
  if (!visible || !input.loaded) return null;
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

/** Speaks queue and conflict changes in the shell polite live region (#1540). */
export function useOfflineAttentionAnnouncement(input: Input): void {
  const announceStatus = useDaw((s) => s.announceStatus);
  const last = useRef<string | null>(null);

  useEffect(() => {
    const message = attentionAnnouncement(input);
    if (!message) {
      last.current = null;
      return;
    }
    if (message === last.current) return;
    last.current = message;
    announceStatus(message, { toast: false });
  }, [
    announceStatus,
    input.conflictCount,
    input.dismissFailed,
    input.loaded,
    input.pending,
    input.status,
    input.unreadable,
  ]);
}
