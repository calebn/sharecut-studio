import { canRetimePendingEdit, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { pendingEditTimingFieldId } from "../utils/pendingEditTimingField";
import type { ExecuteResult } from "./types";

/**
 * True where a pending edit's accept verb is Cut (and its reject verb Keep): the suggestion has a
 * cut, shorten or lower action and is neither a split nor an exact range proposal. The inspector
 * sheet, the timeline overlay bar and the pinned phone chrome name Cut and Keep by this one test;
 * everywhere else they say Approve and Reject. The Action bar's own primary verb follows
 * `suggested_action` alone (no split or exact range mask), so for those edits it can still say Cut.
 */
export function pendingOffersCut(
  edit: Pick<PendingEditView, "type" | "exact_range" | "suggested_action">,
): boolean {
  return (
    !edit.exact_range &&
    edit.type !== "split" &&
    edit.suggested_action != null &&
    edit.suggested_action !== "leave"
  );
}

/**
 * True where the Action bar carries a pending edit's Cut and Keep and the timeline overlay bar
 * stays out of the way: a cut-family suggestion (not a split or an exact range) the viewer may
 * review. The caller adds that the Action bar is mounted (the Edit stage).
 */
export function actionBarOwnsPendingVerbs(
  edit: Pick<PendingEditView, "type" | "exact_range" | "suggested_action">,
  canReview: boolean,
): boolean {
  return canReview && pendingOffersCut(edit);
}

const TIMING_FOCUS_FRAMES = 30;

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
  const attempt = (framesLeft: number) =>
    requestAnimationFrame(() => {
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
      if (document.activeElement !== field && framesLeft > 0)
        attempt(framesLeft - 1);
    });
  attempt(TIMING_FOCUS_FRAMES);
}

/** The accept verb's words for an edit that offers Cut: the bar's own label and its busy text. */
export function pendingCutWords(
  edit: Pick<PendingEditView, "suggested_action">,
): { label: string; busy: string } {
  switch (edit.suggested_action) {
    case "shorten":
      return { label: "Shorten", busy: "Shortening…" };
    case "lower":
      return { label: "Lower", busy: "Lowering…" };
    default:
      return { label: "Cut", busy: "Cutting…" };
  }
}

type PendingDecider = (action: "approve" | "reject") => Promise<string | null>;

let current: {
  editId: string;
  decide: PendingDecider;
  busyReason: () => string | null;
} | null = null;

export function registerPendingDecider(
  editId: string,
  decide: PendingDecider,
  busyReason: () => string | null,
): () => void {
  const entry = { editId, decide, busyReason };
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

export function sheetBusyReason(editId: string): string | null {
  return current?.editId === editId ? current.busyReason() : null;
}
