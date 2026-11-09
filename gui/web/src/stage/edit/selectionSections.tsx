import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { useBleedSections } from "./bleedSections";
import { useChapterSections } from "./chapterSections";
import { useClipSections } from "./clipSections";
import { useCommentSections } from "./commentSections";
import { usePendingSections } from "./pendingSections";
import { rangeSection } from "./rangeSection";
import { useSeamSections } from "./seamSections";
import { useSocialSections } from "./socialSections";
import { useTrackSections } from "./trackSections";
import { useWordSections } from "./wordSections";

export function useSelectionSections(
  selection: Selection,
  rangeActionsInSheet = false,
  barShown = false,
): readonly InspectorSection[] | null {
  const word = useWordSections(selection);
  const seam = useSeamSections(selection);
  const bleed = useBleedSections(selection);
  const clip = useClipSections(selection);
  const comment = useCommentSections(selection);
  const pending = usePendingSections(selection, barShown);
  const track = useTrackSections(selection);
  const chapter = useChapterSections(selection);
  const social = useSocialSections(selection);
  if (word) return word;
  const rest =
    seam ?? bleed ?? clip ?? comment ?? pending ?? track ?? chapter ?? social;
  if (!rest) return null;
  return rangeActionsInSheet ? [rangeSection, ...rest] : rest;
}
