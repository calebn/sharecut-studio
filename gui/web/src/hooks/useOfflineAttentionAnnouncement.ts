import { useRef } from "react";
import { attentionRegionLabel } from "../layout/attentionLabel";
import type { AttentionStatus } from "../state/offlineAttention";

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

type LiveState = { projectPath: string; message: string; seq: number };

export function useOfflineAttentionAnnouncement(input: Input): {
  liveMessage: string;
  liveSeq: number;
} {
  const {
    projectPath,
    pending,
    conflictCount,
    unreadable,
    dismissFailed,
    loaded,
    status,
  } = input;
  const live = useRef<LiveState>({ projectPath: "", message: "", seq: 0 });

  if (live.current.projectPath !== projectPath) {
    live.current = { projectPath, message: "", seq: 0 };
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

  if (message) {
    if (message !== live.current.message) {
      live.current = {
        projectPath,
        message,
        seq: live.current.seq + 1,
      };
    }
  } else if (
    status !== "checking" &&
    status !== "dismissing" &&
    !(unreadable && !loaded)
  ) {
    live.current = { projectPath, message: "", seq: live.current.seq };
  }

  return {
    liveMessage: live.current.message,
    liveSeq: live.current.seq,
  };
}
