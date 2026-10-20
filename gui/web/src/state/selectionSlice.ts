import type { StateCreator } from "zustand";
import type { Selection } from "../types/project";
import {
  clipClickSelection,
  settleSelection,
  trackClickSelection,
  tracksSelection,
} from "./selection";
import type { DawStore } from "./types";

type SelectionSlice = Pick<
  DawStore,
  | "selection"
  | "setSelection"
  | "selectClip"
  | "toggleTrackSelected"
  | "selectTracks"
>;

/**
 * The state a new selection implies, shared by local and remote writes. This
 * module is the only one that writes `selection`; every other module spreads
 * this patch (`state/selectionGovernance.test.ts` fails a second writer).
 */
export function selectionPatch(
  current: Selection,
  next: Selection,
): Pick<DawStore, "selection" | "pendingWireSelection"> {
  return {
    selection: settleSelection(current, next),
    pendingWireSelection: null,
  };
}

/** A new project starts with nothing selected; a wire selection waiting for its target stays. */
export const NO_SELECTION: Pick<DawStore, "selection"> = { selection: null };

/** `next` exactly as given: a click or a set of tracks already worked out the whole selection. */
function exactSelection(
  next: Selection,
): Pick<DawStore, "selection" | "pendingWireSelection"> {
  return { selection: next, pendingWireSelection: null };
}

export const createSelectionSlice: StateCreator<
  DawStore,
  [],
  [],
  SelectionSlice
> = (set) => ({
  selection: null as Selection,
  setSelection: (selection) =>
    set((s) => selectionPatch(s.selection, selection)),
  selectClip: (clipId, trackId, mods) =>
    set((s) =>
      exactSelection(
        clipClickSelection(s.selection, s.project, clipId, trackId, mods),
      ),
    ),
  toggleTrackSelected: (trackId, additive) =>
    set((s) =>
      exactSelection(trackClickSelection(s.selection, trackId, additive)),
    ),
  selectTracks: (trackIds) =>
    set(() => exactSelection(tracksSelection(trackIds))),
});
