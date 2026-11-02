import type { PendingEditView } from "../types/project";
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
