import { useEffect, useRef } from "react";
import { attentionRegionLabel } from "../layout/attentionLabel";
import type { AttentionStatus } from "../state/offlineAttention";
import { useDaw } from "../state/useDaw";

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

export function useOfflineAttentionAnnouncement(input: Input): void {
  const announceStatus = useDaw((s) => s.announceStatus);
  const last = useRef<{ projectPath: string; message: string | null }>({
    projectPath: "",
    message: null,
  });

  useEffect(() => {
    if (last.current.projectPath !== input.projectPath) {
      last.current = { projectPath: input.projectPath, message: null };
    }
    const message = attentionAnnouncement(input);
    if (!message) {
      if (
        input.status === "checking" ||
        input.status === "dismissing" ||
        (input.unreadable && !input.loaded)
      ) {
        return;
      }
      last.current.message = null;
      return;
    }
    if (message === last.current.message) return;
    last.current.message = message;
    announceStatus(message, { toast: false });
  }, [
    announceStatus,
    input.conflictCount,
    input.dismissFailed,
    input.loaded,
    input.pending,
    input.projectPath,
    input.status,
    input.unreadable,
  ]);
}
