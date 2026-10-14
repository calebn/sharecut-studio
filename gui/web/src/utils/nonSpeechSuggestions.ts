import type { ConfirmQuestion } from "../feedback/ask";
import type { PendingEditView } from "../types/project";

export function hasSuggestedAction(edit: PendingEditView): boolean {
  return (
    typeof edit.suggested_action === "string" &&
    edit.suggested_action.length > 0
  );
}

export function suggestedActionIds(
  edits: readonly PendingEditView[],
  listedIds: readonly string[] | null,
): string[] {
  const scope = listedIds ? new Set(listedIds) : null;
  return edits
    .filter((e) => (scope === null || scope.has(e.id)) && hasSuggestedAction(e))
    .map((e) => e.id);
}

const ACTION_LABEL: Record<string, string> = {
  cut: "Cut",
  shorten: "Shorten",
  lower: "Lower",
  leave: "Leave",
};

export function formatSuggestedAction(
  action: string | null | undefined,
): string {
  if (!action) return "—";
  return ACTION_LABEL[action] ?? action;
}

export function applySuggestedSummary(count: number): {
  question: Omit<ConfirmQuestion, "kind">;
  button: string;
} {
  const noun = count === 1 ? "hit" : "hits";
  return {
    question: {
      title: `Apply suggested actions for ${count} ${noun}?`,
      message: "Their cuts, shortens, or level changes go into the timeline.",
      keepLabel: "Keep reviewing",
      actionLabel: `Apply suggested (${count})`,
      danger: false,
    },
    button: `Apply suggested actions (${count})`,
  };
}
