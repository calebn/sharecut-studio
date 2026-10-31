import type { InspectorSection } from "../../system/InspectorSheet";
import { RangeFields } from "../../timeline/RangeFields";
import type { Selection } from "../../types/project";
import { useAppliedSections } from "./appliedSections";
import { useWordSections } from "./wordSections";

/** The sheet content a selection kind has been rebuilt for, or null for a legacy body. */
export function useSelectionSections(
  selection: Selection,
  rangeActionsInSheet = false,
): readonly InspectorSection[] | null {
  const word = useWordSections(selection);
  const applied = useAppliedSections(selection);
  if (word) return word;
  if (!applied) return null;
  return rangeActionsInSheet
    ? [
        {
          id: "range",
          rows: [{ id: "range", control: <RangeFields sheet /> }],
        },
        ...applied,
      ]
    : applied;
}
