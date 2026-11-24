import type { PendingEditView } from "../types/project";

/**
 * True where a pending edit's accept verb is Cut (and its reject verb Keep): the suggestion has a
 * cut, shorten or lower action and is neither a split nor an exact range proposal. Everywhere else
 * the Action bar, the Inspector sheet and the timeline overlay bar say Approve and Reject.
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
