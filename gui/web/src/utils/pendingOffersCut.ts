import type { PendingEditView } from "../types/project";

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
