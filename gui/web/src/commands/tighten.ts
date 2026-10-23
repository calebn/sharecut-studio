import { applySuggestedActions, approveEdits, rejectEdits } from "../api";
import { playPendingPreview } from "../audio/pendingPreview";
import { askConfirm } from "../feedback/ask";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";
import {
  isSoundAction,
  revisableSuggestedBatch,
  type SoundAction,
} from "../utils/suggestedBatch";
import {
  applySuggestedSummary,
  isTightenPending,
  listTightenHits,
  tightenHitsForListedIds,
} from "../utils/tightenHits";
import { registerCommand } from "./execute";
import { createSingleFlight } from "./singleFlight";
import type { ExecuteResult } from "./types";

const tightenFlight = createSingleFlight();

export type ApplyingSuggested = Readonly<{
  projectPath: string;
  projectEpoch: number;
  ids: readonly string[];
  startedAtSec: number;
}>;

let applyingSuggested: ApplyingSuggested | null = null;
const applyListeners = new Set<() => void>();

export function getApplyingSuggested(): ApplyingSuggested | null {
  return applyingSuggested;
}

export function subscribeApplyingSuggested(listener: () => void): () => void {
  applyListeners.add(listener);
  return () => {
    applyListeners.delete(listener);
  };
}

function publishApplyingSuggested(operation: ApplyingSuggested | null): void {
  applyingSuggested = operation;
  for (const listener of [...applyListeners]) listener();
}

type ApplyScope = Pick<ApplyingSuggested, "projectPath" | "projectEpoch">;

function isCurrentApplyScope(scope: ApplyScope): boolean {
  const current = useDawStore.getState();
  return (
    current.projectPath === scope.projectPath &&
    current.projectEpoch === scope.projectEpoch
  );
}

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

async function runApprove(ids: string[]): Promise<ExecuteResult> {
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
      const { queued, historyHead } = await approveEdits(projectPath, ids);
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
      useDawStore
        .getState()
        .announceStatus(`Apply failed: ${msg}`, { tone: "error" });
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
      useDawStore
        .getState()
        .announceStatus(`Skip failed: ${msg}`, { tone: "error" });
      return { status: "disabled", reason: msg };
    }
  });
  return result.ran
    ? result.value
    : { status: "disabled", reason: "Tighten action in progress" };
}

async function runApplySuggested(
  scope: ApplyScope,
  ids: string[],
): Promise<ExecuteResult> {
  const result = await tightenFlight.run(async (): Promise<ExecuteResult> => {
    const s = useDawStore.getState();
    if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Pass 1–2 edits not allowed" };
    }
    if (!isCurrentApplyScope(scope)) {
      return {
        status: "disabled",
        reason: "The project changed. Apply again.",
      };
    }
    const operation: ApplyingSuggested = {
      ...scope,
      ids: [...ids],
      startedAtSec: Date.now() / 1000,
    };
    publishApplyingSuggested(operation);
    try {
      const { queued, summary, historyHead } = await applySuggestedActions(
        scope.projectPath,
        ids,
      );
      if (!isCurrentApplyScope(scope)) return { status: "ok" };
      const next = useDawStore.getState();
      if (queued) {
        next.announceStatus(PENDING_REVIEW_QUEUED_MESSAGE);
        return { status: "ok" };
      }
      next.setSelection(null);
      next.announceStatus(summary ?? "Applied suggested actions", {
        undo: historyHead,
      });
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      if (isCurrentApplyScope(scope)) {
        useDawStore
          .getState()
          .announceStatus(`Apply failed: ${msg}`, { tone: "error" });
      }
      return { status: "disabled", reason: msg };
    } finally {
      if (applyingSuggested === operation) publishApplyingSuggested(null);
    }
  });
  return result.ran
    ? result.value
    : { status: "disabled", reason: "Tighten action in progress" };
}

async function runReviseSuggested(
  id: string,
  action: SoundAction,
): Promise<ExecuteResult> {
  const result = await tightenFlight.run(async (): Promise<ExecuteResult> => {
    const s = useDawStore.getState();
    if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Pass 1–2 edits not allowed" };
    }
    try {
      const { queued, historyHead } = await applySuggestedActions(
        s.projectPath,
        null,
        { [id]: action },
        true,
      );
      const next = useDawStore.getState();
      if (queued) {
        next.announceStatus(PENDING_REVIEW_QUEUED_MESSAGE);
        return { status: "ok" };
      }
      // The server summary counts the whole re-applied batch; this change is one sound,
      // and Undo puts back the batch from before it.
      next.announceStatus(
        "Changed the sound. Undo puts back the whole batch.",
        {
          undo: historyHead,
        },
      );
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore
        .getState()
        .announceStatus(`Change failed: ${msg}`, { tone: "error" });
      return { status: "disabled", reason: msg };
    }
  });
  return result.ran
    ? result.value
    : { status: "disabled", reason: "Tighten action in progress" };
}

function resolveApplyAllArgs(args: Record<string, unknown>): {
  listedIds: string[] | null;
} {
  if (Array.isArray(args.ids)) {
    return {
      listedIds: args.ids.filter((id): id is string => typeof id === "string"),
    };
  }
  const scope = useDawStore.getState().tightenApplyScope;
  return { listedIds: scope.ids.length ? [...scope.ids] : null };
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

  registerCommand("tighten.applySuggested", async (args) => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    const scope = { projectPath: s.projectPath, projectEpoch: s.projectEpoch };
    const { listedIds } = resolveApplyAllArgs(args);
    const hits = hitsForApplyAll(s.project, listedIds);
    if (hits.length === 0) {
      return { status: "disabled", reason: "Nothing to apply" };
    }
    if (!(await askConfirm(applySuggestedSummary(hits.length).question))) {
      return { status: "disabled", reason: "Cancelled" };
    }
    const fresh = useDawStore.getState();
    if (!isCurrentApplyScope(scope)) {
      return {
        status: "disabled",
        reason: "The project changed. Apply again.",
      };
    }
    if (!fresh.project) {
      return { status: "disabled", reason: "No project" };
    }
    const ids = hitsForApplyAll(fresh.project, listedIds).map((h) => h.id);
    if (ids.length === 0) {
      return { status: "disabled", reason: "Nothing to apply" };
    }
    return runApplySuggested(scope, ids);
  });

  registerCommand("tighten.reviseSuggested", async (args) => {
    const { id, action } = args;
    if (typeof id !== "string" || !id || !isSoundAction(action)) {
      return { status: "disabled", reason: "Pick a sound and an action" };
    }
    const project = useDawStore.getState().project;
    if (
      !project ||
      !revisableSuggestedBatch(project).some((sound) => sound.id === id)
    ) {
      return {
        status: "disabled",
        reason: "Only the latest applied batch can be changed",
      };
    }
    return runReviseSuggested(id, action);
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
