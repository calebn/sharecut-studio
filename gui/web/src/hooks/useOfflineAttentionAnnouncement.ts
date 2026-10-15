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
  const {
    projectPath,
    pending,
    conflictCount,
    unreadable,
    dismissFailed,
    loaded,
    status,
  } = input;
  const announceStatus = useDaw((s) => s.announceStatus);
  const last = useRef<{ projectPath: string; message: string | null }>({
    projectPath: "",
    message: null,
  });

  useEffect(() => {
    if (last.current.projectPath !== projectPath) {
      last.current = { projectPath, message: null };
    }
    const message = attentionAnnouncement({
      projectPath,
      pending,
      conflictCount,
      unreadable,
      dismissFailed,
      loaded,
      status,
    });
    if (!message) {
      if (
        status === "checking" ||
        status === "dismissing" ||
        (unreadable && !loaded)
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
    conflictCount,
    dismissFailed,
    loaded,
    pending,
    projectPath,
    status,
    unreadable,
  ]);
}
