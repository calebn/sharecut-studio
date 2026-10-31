import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { useAppliedSections } from "./appliedSections";
import { useBleedSections } from "./bleedSections";
import { rangeSection } from "./rangeSection";
import { useWordSections } from "./wordSections";

export function useSelectionSections(
  selection: Selection,
  rangeActionsInSheet = false,
): readonly InspectorSection[] | null {
  const word = useWordSections(selection);
  const applied = useAppliedSections(selection);
  const bleed = useBleedSections(selection);
  if (word) return word;
  const rest = applied ?? bleed;
  if (!rest) return null;
  return rangeActionsInSheet ? [rangeSection, ...rest] : rest;
}
