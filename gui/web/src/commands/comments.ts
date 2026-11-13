import { commentDraftFromRange } from "../comments/commentAnchor";
import { selectionSpan } from "../edit/editSelection";
import { resolveSelectionRange } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import type { CommentDraft, DawState } from "../state/types";
import { clampToSession } from "../utils/time";
import { dispatchComposer } from "./composer";
import { buildCommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/**
 * Starts a comment at `draft` in the Review composer, pausing the episode if it
 * plays. `replacePin`: the anchor was chosen (a range, a time), so it replaces
 * the pin of text already typed.
 */
export function openCommentDraft(draft: CommentDraft, replacePin = true): void {
  dispatchComposer({ type: "open", anchor: draft, replacePin });
  useDawStore.getState().openStage("review", { section: "queue" });
}

/** The draft a selection makes, and whether the selection chose it (else it is "here"). */
function draftForSelection(
  state: Pick<DawState, "project" | "selection" | "playheadSec">,
): { draft: CommentDraft; chosen: boolean } {
  const project = state.project!;
  const resolved = resolveSelectionRange(project, state.selection);
  if (resolved.targets.length === 1)
    return { draft: commentDraftFromRange(resolved.targets[0]!), chosen: true };
  const span = selectionSpan(state.selection, project);
  if (span) {
    return {
      draft: {
        startSec: clampToSession(span.start, project.timeline_duration_sec),
        endSec:
          span.end > span.start
            ? clampToSession(span.end, project.timeline_duration_sec)
            : null,
        ...(span.trackIds.length ? { trackIds: [...span.trackIds] } : {}),
      },
      chosen: true,
    };
  }
  return {
    draft: {
      startSec: clampToSession(
        state.playheadSec,
        project.timeline_duration_sec,
      ),
      endSec: null,
    },
    chosen: false,
  };
}

/**
 * `comment.draftAt`: a comment anchored at `atTime` (on `trackId`, if
 * given). The touch create menu runs it (#1051). `keepPin`: "here", so text
 * already typed keeps the time it was typed at.
 */
export function registerCommentCommands(): void {
  registerCommand("comment.draftAt", (args): ExecuteResult => {
    // Pointer dispatch skips `when`; the permission still holds.
    const allowed = evaluateWhen("canComment", buildCommandContext());
    if (!allowed.ok) return { status: "disabled", reason: allowed.reason };
    const { project } = useDawStore.getState();
    if (args.atTime === undefined || args.atTime === null) {
      if (!project) return { status: "disabled", reason: "No project loaded" };
      const { draft, chosen } = draftForSelection(useDawStore.getState());
      openCommentDraft(draft, chosen);
      return { status: "ok" };
    }
    const raw = Number(args.atTime);
    if (!project || !Number.isFinite(raw)) {
      return { status: "disabled", reason: "atTime must be a number" };
    }
    const trackId = typeof args.trackId === "string" ? args.trackId : null;
    openCommentDraft(
      {
        startSec: clampToSession(raw, project.timeline_duration_sec),
        endSec: null,
        ...(trackId ? { trackIds: [trackId] } : {}),
      },
      args.keepPin !== true,
    );
    return { status: "ok" };
  });
}
