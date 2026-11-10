import type { StateCreator } from "zustand";
import type { HistoryEntryId, Selection } from "../types/project";
import type { EditWordReveal } from "./stageSlice";
import type { DawStore } from "./types";

type TranscriptRange = Extract<Selection, { kind: "transcriptRange" }>;

export type AfterCutDirection = "next" | "prev";

/**
 * What a words cut left to follow: the cut words, where they were, and the
 * state that proves the cut is still the latest thing the person did. It is
 * live only while `selected` equals the live selection and the history head is
 * `head` or `baseHead` (`commands/context.ts` `afterCutActive`).
 */
export type AfterCut = Readonly<{
  words: string;
  cutKeys: readonly string[];
  from: EditWordReveal;
  head: HistoryEntryId | null;
  baseHead: HistoryEntryId | null;
  epoch: number;
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
