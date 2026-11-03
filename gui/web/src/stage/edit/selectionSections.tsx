import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { useAppliedSections } from "./appliedSections";
import { useBleedSections } from "./bleedSections";
import { useClipSections } from "./clipSections";
import { useCommentSections } from "./commentSections";
import { usePendingSections } from "./pendingSections";
import { rangeSection } from "./rangeSection";
import { useTrackSections } from "./trackSections";
import { useWordSections } from "./wordSections";

export function useSelectionSections(
  selection: Selection,
  rangeActionsInSheet = false,
  barShown = false,
): readonly InspectorSection[] | null {
  const word = useWordSections(selection);
  const applied = useAppliedSections(selection);
  const bleed = useBleedSections(selection);
  const clip = useClipSections(selection);
  const comment = useCommentSections(selection);
  const pending = usePendingSections(selection, barShown);
  const track = useTrackSections(selection);
  if (word) return word;
  const rest = applied ?? bleed ?? clip ?? comment ?? pending ?? track;
  if (!rest) return null;
  return rangeActionsInSheet ? [rangeSection, ...rest] : rest;
}
