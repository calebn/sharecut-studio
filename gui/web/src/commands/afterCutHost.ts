import type { AfterCut, AfterCutDirection } from "../state/afterCutSlice";
import type { EditWordReveal } from "../state/stageSlice";
import type { ProjectView, Selection } from "../types/project";

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

export type AfterCutPick = {
  selection: TranscriptRange;
  at: EditWordReveal;
  startedAt: EditWordReveal;
  words: string;
  ordinal: number;
  total: number;
};

type AfterCutNavigator = (
  project: ProjectView,
  afterCut: AfterCut,
  direction: AfterCutDirection,
) => AfterCutPick | null;

let navigator: AfterCutNavigator | null = null;

export function registerAfterCutNavigator(next: AfterCutNavigator): void {
  navigator = next;
}

export function afterCutPick(
  project: ProjectView,
  afterCut: AfterCut,
  direction: AfterCutDirection,
): AfterCutPick | null {
  try {
    return navigator?.(project, afterCut, direction) ?? null;
  } catch {
    return null;
  }
}
