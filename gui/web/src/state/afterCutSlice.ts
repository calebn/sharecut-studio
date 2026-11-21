import type { StateCreator } from "zustand";
import {
  type HistoryEntryId,
  historyEditChanged,
  type ProjectView,
  type Selection,
} from "../types/project";
import type { EditWordReveal } from "./stageSlice";
import type { DawStore } from "./types";

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

export type AfterCutDirection = "next" | "prev";

export type AfterCut = Readonly<{
  words: string;
  cutKeys: readonly string[];
  from: EditWordReveal;
  head: HistoryEntryId | null;
  baseHead: HistoryEntryId | null;
  epoch: number;
  focused: boolean;
  holdUntil: number;
  holdTabOnly?: true;
  selected: TranscriptRange | null;
  at: EditWordReveal | null;
  startedAt: EditWordReveal | null;
  direction: AfterCutDirection | null;
}>;

export function afterCutAfterProject(
  {
    afterCut,
    project,
    rangeBusy,
  }: Pick<DawStore, "afterCut" | "project" | "rangeBusy">,
  next: ProjectView,
): AfterCut | null {
  const previous = project?.history;
  const history = next.history;
  if (
    !afterCut ||
    afterCut.holdTabOnly ||
    !history ||
    !historyEditChanged(previous, history) ||
    (history.edit_head_id ?? history.head_id) === afterCut.head ||
    ((previous?.edit_head_id ?? previous?.head_id) === afterCut.head &&
      history.can_redo)
  )
    return afterCut;

  return rangeBusy ? { ...afterCut, holdTabOnly: true } : null;
}

export interface AfterCutSliceState {
  afterCut: AfterCut | null;
  setAfterCut: (afterCut: AfterCut | null) => void;
}

export const createAfterCutSlice: StateCreator<
  DawStore,
  [],
  [],
  AfterCutSliceState
> = (set) => ({
  afterCut: null,
  setAfterCut: (afterCut) => set({ afterCut }),
});
