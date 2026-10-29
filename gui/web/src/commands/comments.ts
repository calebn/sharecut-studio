import { commentDraftFromRange } from "../comments/commentAnchor";
import { selectionSpan } from "../edit/editSelection";
import { resolveSelectionRange } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import type { CommentDraft, DawState } from "../state/types";
import { clampToSession } from "../utils/time";
import { buildCommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/** Starts a comment on `draft` in the Comments panel. */
export function openCommentDraft(draft: CommentDraft): void {
  const state = useDawStore.getState();
  state.setCommentDraft(draft);
  state.openStage("review", { section: "comments" });
}

function draftForSelection(
  state: Pick<DawState, "project" | "selection" | "playheadSec">,
): CommentDraft {
  const project = state.project!;
  const resolved = resolveSelectionRange(project, state.selection);
  if (resolved.targets.length === 1)
    return commentDraftFromRange(resolved.targets[0]!);
  const span = selectionSpan(state.selection, project);
  if (span) {
    return {
      startSec: clampToSession(span.start, project.timeline_duration_sec),
      endSec:
        span.end > span.start
          ? clampToSession(span.end, project.timeline_duration_sec)
          : null,
      ...(span.trackIds.length ? { trackIds: [...span.trackIds] } : {}),
    };
  }
  return {
    startSec: clampToSession(state.playheadSec, project.timeline_duration_sec),
    endSec: null,
  };
}

/**
 * `comment.draftAt`: a comment anchored at `atTime` (on `trackId`, if
 * given). The touch create menu runs it (#1051).
 */
export function registerCommentCommands(): void {
  registerCommand("comment.draftAt", (args): ExecuteResult => {
    // Pointer dispatch skips `when`; the permission still holds.
    const allowed = evaluateWhen("canComment", buildCommandContext());
    if (!allowed.ok) return { status: "disabled", reason: allowed.reason };
    const { project } = useDawStore.getState();
    if (args.atTime === undefined || args.atTime === null) {
      if (!project) return { status: "disabled", reason: "No project loaded" };
      openCommentDraft(draftForSelection(useDawStore.getState()));
      return { status: "ok" };
    }
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
