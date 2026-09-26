import { patchComment } from "../api";
import { canManageProjects, guestHearsMixOnly } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { AuditionMode, FocusMode } from "../state/types";
import { errorMessage } from "../utils/apiError";
import { clampToSession } from "../utils/time";
import { registerCommand } from "./execute";

export function registerNavigationCommands(): void {
  registerCommand("transport.togglePlay", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "Project not loaded" };
    }
    s.togglePlaying();
    return { status: "ok" };
  });

  registerCommand("transport.stop", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "Project not loaded" };
    }
    s.setIsPlaying(false);
    return { status: "ok" };
  });

  registerCommand("transport.seek", (args) => {
    const sec = Number(args.sec);
    if (!Number.isFinite(sec)) {
      return { status: "disabled", reason: "sec must be a number" };
    }
    const s = useDawStore.getState();
    const duration = s.project?.timeline_duration_sec ?? Number.NaN;
    s.setPlayheadSec(clampToSession(sec, duration));
    return { status: "ok" };
  });

  const AUDITION = new Set(["mix", "fx", "raw"]);
  registerCommand("transport.audition", (args) => {
    const mode = args.mode;
    if (typeof mode !== "string" || !AUDITION.has(mode)) {
      return { status: "disabled", reason: "mode required" };
    }
    if (guestHearsMixOnly(useDawStore.getState().guestMode) && mode !== "mix") {
      return { status: "disabled", reason: "guests hear Mix only" };
    }
    useDawStore.getState().setAuditionMode(mode as AuditionMode);
    return { status: "ok" };
  });

  registerCommand("presence.follow", (args) => {
    const clientId = typeof args.clientId === "string" ? args.clientId : "";
    if (!clientId) {
      return { status: "disabled", reason: "clientId required" };
    }
    const s = useDawStore.getState();
    if (s.followingClientId === clientId) {
      s.stopFollow("local");
      return { status: "ok" };
    }
    s.startFollow(clientId);
    return { status: "ok" };
  });

  registerCommand("presence.unfollow", () => {
    useDawStore.getState().stopFollow("local");
    return { status: "ok" };
  });

  registerCommand("tool.select", () => {
    useDawStore.getState().setToolMode("select");
    return { status: "ok" };
  });

  registerCommand("tool.blade", () => {
    useDawStore.getState().setToolMode("blade");
    return { status: "ok" };
  });

  registerCommand("review.exitCommentMode", () => {
    useDawStore.getState().setCommentMode(false);
    return { status: "ok" };
  });

  registerCommand("review.toggleCommentMode", () => {
    useDawStore.getState().toggleCommentMode();
    return { status: "ok" };
  });

  registerCommand("comment.resolve", async (args) => {
    const s = useDawStore.getState();
    if (
      !s.project ||
      s.guestMode != null ||
      !canManageProjects(s.projectPath)
    ) {
      return { status: "disabled", reason: "Comment resolve is host-only" };
    }
    const { commentId, resolved, by } = args;
    if (
      typeof commentId !== "string" ||
      !commentId ||
      typeof resolved !== "boolean" ||
      typeof by !== "string" ||
      !by.trim()
    ) {
      return {
        status: "disabled",
        reason: "Invalid comment resolve arguments",
      };
    }
    const comment = s.project.comments?.find((c) => c.id === commentId);
    if (!comment) {
      return { status: "disabled", reason: "Unknown comment" };
    }
    if (resolved && comment.resolved) {
      return { status: "disabled", reason: "Comment is already resolved" };
    }
    try {
      await patchComment(s.projectPath, commentId, { resolved, by });
      return { status: "ok" };
    } catch (e) {
      return { status: "disabled", reason: errorMessage(e) };
    }
  });

  const setFocus = (mode: FocusMode) => {
    useDawStore.getState().setFocusMode(mode);
    return { status: "ok" } as const;
  };

  registerCommand("focus.default", () => setFocus("default"));
  registerCommand("focus.timeline", () => setFocus("timeline"));
  registerCommand("focus.text", () => setFocus("text"));
  registerCommand("focus.review", () => setFocus("review"));
  registerCommand("focus.cycle", () => {
    useDawStore.getState().cycleFocusMode();
    return { status: "ok" };
  });

  registerCommand("navigation.nudgePlayheadBack", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, ctx.playheadSec - delta));
    return { status: "ok" };
  });

  registerCommand("navigation.nudgePlayheadForward", (args, ctx) => {
    const delta = args.shift ? 5 : 1;
    const s = useDawStore.getState();
    s.setPlayheadSec(
      Math.min(ctx.timelineDurationSec, ctx.playheadSec + delta),
    );
    return { status: "ok" };
  });

  registerCommand("navigation.goToStart", () => {
    const s = useDawStore.getState();
    s.setPlayheadSec(0);
    return { status: "ok" };
  });

  registerCommand("navigation.goToEnd", (_args, ctx) => {
    const end = Number.isFinite(ctx.timelineDurationSec)
      ? ctx.timelineDurationSec
      : 0;
    const s = useDawStore.getState();
    s.setPlayheadSec(Math.max(0, end));
    return { status: "ok" };
  });
}
