import type { StateCreator } from "zustand";
import type { HistoryEntryId, Selection } from "../types/project";
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
  selected: TranscriptRange | null;
  at: EditWordReveal | null;
  startedAt: EditWordReveal | null;
  direction: AfterCutDirection | null;
}>;

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
