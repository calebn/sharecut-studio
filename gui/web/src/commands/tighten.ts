import { approveEdits, rejectEdits } from "../api";
import { playPendingPreview } from "../audio/pendingPreview";
import { askConfirm } from "../feedback/ask";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";
import {
  applyAllSummary,
  eligibleApplyAllIds,
  isTightenPending,
  listTightenHits,
  tightenHitsForListedIds,
} from "../utils/tightenHits";
import { registerCommand } from "./execute";
import { createSingleFlight } from "./singleFlight";
import type { ExecuteResult } from "./types";

const tightenFlight = createSingleFlight();

export function resolveTightenHitId(
  args: Record<string, unknown>,
): string | null {
  if (typeof args.id === "string" && args.id) {
    return args.id;
  }
  const s = useDawStore.getState();
  if (s.selection?.kind === "pending") {
    return s.selection.id;
  }
  return null;
}

export function pendingTightenHit(
  id: string | null,
): PendingEditView | undefined {
  if (!id) {
    return undefined;
  }
  const edit = useDawStore
    .getState()
    .project?.pending_edits.find((e) => e.id === id);
  if (!edit || !isTightenPending(edit)) {
    return undefined;
  }
  return edit;
}

async function runApprove(
  ids: string[],
  allowReview = true,
): Promise<ExecuteResult> {
  const result = await tightenFlight.run(async (): Promise<ExecuteResult> => {
    const s = useDawStore.getState();
    if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Pass 1–2 edits not allowed" };
    }
    if (ids.length === 0) {
      return { status: "disabled", reason: "No tighten hits to apply" };
    }
    try {
      const projectPath = useDawStore.getState().projectPath;
      const { queued, asked, historyHead } = await approveEdits(
        projectPath,
        ids,
        false,
        allowReview,
      );
      if (asked) return { status: "ok" };
      const next = useDawStore.getState();
      if (queued) {
        // Saved but not sent yet: keep the selection and say so.
        next.announceStatus(PENDING_REVIEW_QUEUED_MESSAGE);
        return { status: "ok" };
      }
      const sel = next.selection;
      if (
        sel?.kind === "pending" &&
        !next.project?.pending_edits.some((e) => e.id === sel.id)
      ) {
        next.setSelection(null);
      }
      next.announceStatus(
        ids.length === 1
          ? "Applied tighten hit"
          : `Applied ${ids.length} tighten hits`,
        { undo: historyHead },
      );
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Apply failed: ${msg}`);
      return { status: "disabled", reason: msg };
    }
  });
  return result.ran
    ? result.value
    : { status: "disabled", reason: "Tighten action in progress" };
}

async function runReject(id: string): Promise<ExecuteResult> {
  const result = await tightenFlight.run(async (): Promise<ExecuteResult> => {
    const s = useDawStore.getState();
    if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Pass 1–2 edits not allowed" };
    }
    try {
      const projectPath = useDawStore.getState().projectPath;
      const { queued, historyHead } = await rejectEdits(projectPath, [id]);
      const next = useDawStore.getState();
      if (queued) {
        // Saved but not sent yet: keep the selection and say so.
        next.announceStatus(PENDING_REVIEW_QUEUED_MESSAGE);
        return { status: "ok" };
      }
      if (next.selection?.kind === "pending" && next.selection.id === id) {
        next.setSelection(null);
      }
      next.announceStatus("Skipped tighten hit", {
        undo: historyHead,
      });
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Skip failed: ${msg}`);
      return { status: "disabled", reason: msg };
    }
  });
  return result.ran
    ? result.value
    : { status: "disabled", reason: "Tighten action in progress" };
}

function resolveApplyAllArgs(args: Record<string, unknown>): {
  avoidHarsh: boolean;
  listedIds: string[] | null;
} {
  const scope = useDawStore.getState().tightenApplyScope;
  const avoidHarsh =
    typeof args.avoidHarsh === "boolean" ? args.avoidHarsh : scope.avoidHarsh;
  if (Array.isArray(args.ids)) {
    const listedIds = args.ids.filter(
      (id): id is string => typeof id === "string",
    );
    return { avoidHarsh, listedIds };
  }
  return { avoidHarsh, listedIds: scope.ids.length ? [...scope.ids] : null };
}

function hitsForApplyAll(
  project: NonNullable<ReturnType<typeof useDawStore.getState>["project"]>,
  listedIds: string[] | null,
) {
  const transcript = project.transcript ?? null;
  if (listedIds) {
    return tightenHitsForListedIds(
      project.pending_edits,
      transcript,
      listedIds,
    );
  }
  return listTightenHits(project.pending_edits, transcript);
}

export function registerTightenCommands(): void {
  registerCommand("tighten.applyHit", async (args) => {
    const edit = pendingTightenHit(resolveTightenHitId(args));
    if (!edit) {
      return { status: "disabled", reason: "No tighten hit selected" };
    }
    return runApprove([edit.id]);
  });

  registerCommand("tighten.skipHit", async (args) => {
    const edit = pendingTightenHit(resolveTightenHitId(args));
    if (!edit) {
      return { status: "disabled", reason: "No tighten hit selected" };
    }
    return runReject(edit.id);
  });

  registerCommand("tighten.applyAllSafe", async (args) => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    const { avoidHarsh, listedIds } = resolveApplyAllArgs(args);
    const hits = hitsForApplyAll(s.project, listedIds);
    const ids = eligibleApplyAllIds(hits, avoidHarsh);
    const summary = applyAllSummary(hits.length, ids.length);
    if (ids.length === 0) {
      return { status: "disabled", reason: "Nothing is eligible to apply" };
    }
    if (!(await askConfirm(summary.question))) {
      return { status: "disabled", reason: "Cancelled" };
    }
    const fresh = useDawStore.getState();
    if (!fresh.project) {
      return { status: "disabled", reason: "No project" };
    }
    const freshHits = hitsForApplyAll(fresh.project, listedIds);
    const freshIds = eligibleApplyAllIds(freshHits, avoidHarsh);
    if (freshIds.length === 0) {
      return { status: "disabled", reason: "Nothing is eligible to apply" };
    }
    return runApprove(freshIds, !avoidHarsh);
  });

  registerCommand("tighten.previewHit", async (args) => {
    const s = useDawStore.getState();
    const edit = pendingTightenHit(resolveTightenHitId(args));
    if (!edit || !s.projectPath) {
      return { status: "disabled", reason: "No tighten hit selected" };
    }
    if (edit.timeline_start == null || edit.timeline_end == null) {
      return {
        status: "disabled",
        reason: "Timeline position unavailable for this hit",
      };
    }
    const outcome = await playPendingPreview(
      s.projectPath,
      edit.id,
      edit.suggest_reason ? "current" : "suggested",
    );
    return outcome.status === "disabled" ? outcome : { status: "ok" };
  });

  registerCommand("tighten.goToHit", (args) => {
    const s = useDawStore.getState();
    const edit = pendingTightenHit(resolveTightenHitId(args));
    if (!edit) {
      return { status: "disabled", reason: "No tighten hit selected" };
    }
    if (edit.timeline_start == null) {
      return {
        status: "disabled",
        reason: "Timeline position unavailable for this hit",
      };
    }
    s.setSelection({ kind: "pending", id: edit.id, trackId: edit.track_id });
    s.setPlayheadSec(Math.max(0, edit.timeline_start));
    s.setActiveTab("tighten");
    return { status: "ok" };
  });
}
