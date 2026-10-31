import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { useAppliedSections } from "./appliedSections";
import { rangeSection } from "./rangeSection";
import { useWordSections } from "./wordSections";

export function useSelectionSections(
  selection: Selection,
  rangeActionsInSheet = false,
): readonly InspectorSection[] | null {
  const word = useWordSections(selection);
  const applied = useAppliedSections(selection);
  if (word) return word;
  if (!applied) return null;
  return rangeActionsInSheet ? [rangeSection, ...applied] : applied;
}
