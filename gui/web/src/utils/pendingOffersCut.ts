import type { PendingEditView } from "../types/project";

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
