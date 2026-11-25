import { canRetimePendingEdit, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { pendingEditTimingFieldId } from "../utils/pendingEditTimingField";
import { pendingOffersCut } from "../utils/pendingOffersCut";
import type { ExecuteResult } from "./types";

/**
 * True where the Action bar carries a pending edit's accept and reject verbs: any pending edit the
 * viewer may review, and an exact range proposal even when they may not, so a non-reviewer reads
 * the disabled verbs and why on the bar.
 */
export function actionBarOwnsPendingVerbs(
  edit: Pick<PendingEditView, "exact_range">,
  canReview: boolean,
): boolean {
  return canReview || edit.exact_range != null;
}

/** A decision or an edge retime is still in flight for this suggestion: Cut and Keep wait. */
export function pendingDecisionBusy(
  s: Pick<
    ReturnType<typeof useDawStore.getState>,
    "pendingDecisionInFlight" | "pendingRetimeInFlight"
  >,
  editId: string | null,
): boolean {
  return (
    s.pendingDecisionInFlight !== null ||
    (editId !== null && s.pendingRetimeInFlight === editId)
  );
}

const TIMING_FOCUS_BUDGET_MS = 2000;

/**
 * Moves focus to the selected suggestion's Start field in the Inspector once it has mounted, when
 * the viewer may retime it. It retries while the card is still being placed, and a changed project
 * or selection in the meantime leaves focus alone.
 */
export function focusPendingTimingField(editId: string): void {
  const initial = useDawStore.getState();
  const edit = initial.project?.pending_edits.find((e) => e.id === editId);
  if (
    !edit ||
    edit.type === "split" ||
    edit.exact_range ||
    !canSuggestStructural(
      initial.projectPath,
      initial.guestMode,
      initial.shareCapabilities,
    ) ||
    initial.selection?.kind !== "pending" ||
    initial.selection.id !== editId
  )
    return;
  const { projectPath, projectEpoch } = initial;
  const attempt = (deadline: number | null) =>
    requestAnimationFrame((now) => {
      const until = deadline ?? now + TIMING_FOCUS_BUDGET_MS;
      const state = useDawStore.getState();
      if (
        state.projectPath !== projectPath ||
        state.projectEpoch !== projectEpoch ||
        state.selection?.kind !== "pending" ||
        state.selection.id !== editId ||
        !canRetimePendingEdit(
          state.projectPath,
          state.shareCapabilities,
          state.shareAuthor,
          edit.author,
        )
      )
        return;
      const host = document.getElementById(
        pendingEditTimingFieldId(editId, "start"),
      );
      const field = host?.matches("input")
        ? host
        : host?.querySelector<HTMLElement>("[role='spinbutton']");
      if (field instanceof HTMLElement) {
        field.scrollIntoView({ block: "center" });
        field.focus();
      }
      if (document.activeElement === field) return;
      if (now < until) attempt(until);
      else
        state.announceStatus(
          "Source start could not be focused. Try Inspect again.",
          {
            tone: "error",
          },
        );
    });
  attempt(null);
}

/** The accept verb's label for an edit that offers Cut. */
export function pendingCutWords(
  edit: Pick<PendingEditView, "suggested_action">,
): { label: string } {
  switch (edit.suggested_action) {
    case "shorten":
      return { label: "Shorten" };
    case "lower":
      return { label: "Lower" };
    default:
      return { label: "Cut" };
  }
}

export const EXACT_RANGE_REVIEW_REASON =
  "Only the host or an Editor can review exact range proposals.";

export function pendingAcceptRoute(
  edit: Pick<PendingEditView, "type" | "exact_range" | "suggested_action">,
): "own" | "cut" {
  return edit.suggested_action === "leave" ||
    (pendingOffersCut(edit) && edit.suggested_action !== "cut")
    ? "own"
    : "cut";
}

export type PendingBarWords = {
  accept: "Cut" | "Shorten" | "Lower" | "Leave" | "Approve";
  reject: "Keep" | "Reject";
};

export function pendingBarWords(
  edit: Pick<PendingEditView, "type" | "exact_range" | "suggested_action">,
): PendingBarWords {
  if (pendingOffersCut(edit)) {
    return {
      accept: pendingCutWords(edit).label as PendingBarWords["accept"],
      reject: "Keep",
    };
  }
  const leaves = pendingAcceptRoute(edit) === "own";
  return {
    accept: leaves ? "Leave" : "Approve",
    reject: "Reject",
  };
}

type PendingDecider = (action: "approve" | "reject") => Promise<string | null>;

let current: {
  editId: string;
  decide: PendingDecider;
} | null = null;

export function registerPendingDecider(
  editId: string,
  decide: PendingDecider,
): () => void {
  const entry = { editId, decide };
  current = entry;
  return () => {
    if (current === entry) current = null;
  };
}

export async function decideThroughSheet(
  editId: string,
  action: "approve" | "reject",
): Promise<ExecuteResult | null> {
  if (current?.editId !== editId) return null;
  const reason = await current.decide(action);
  return reason === null ? { status: "ok" } : { status: "disabled", reason };
}
