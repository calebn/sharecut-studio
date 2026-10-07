import { useDawStore } from "../state/dawStore";
import type { CommentDraft } from "../state/types";
import { clampToSession } from "../utils/time";
import { buildCommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/** Starts a comment on `draft` in the Comments panel (on phone, More › Comments). */
export function openCommentDraft(draft: CommentDraft): void {
  const state = useDawStore.getState();
  state.setCommentDraft(draft);
  state.setActiveTab("comments");
  state.setMobileMode("more");
  state.setMoreDestination("comments");
}

/**
 * `comment.draftAt`: a comment anchored at `atTime` (on `trackId`, if
 * given), as a ruler press in comment mode anchors one. The touch create
 * menu runs it (#1051).
 */
export function registerCommentCommands(): void {
  registerCommand("comment.draftAt", (args): ExecuteResult => {
    // Pointer dispatch skips `when`; the permission still holds.
    const allowed = evaluateWhen("canComment", buildCommandContext());
    if (!allowed.ok) return { status: "disabled", reason: allowed.reason };
    const { project } = useDawStore.getState();
    const raw = Number(args.atTime);
    if (!project || !Number.isFinite(raw)) {
      return { status: "disabled", reason: "atTime must be a number" };
    }
    const trackId = typeof args.trackId === "string" ? args.trackId : null;
    openCommentDraft({
      startSec: clampToSession(raw, project.timeline_duration_sec),
      endSec: null,
      ...(trackId ? { trackIds: [trackId] } : {}),
    });
    return { status: "ok" };
  });
}
