import type { StateCreator } from "zustand";
import type { Selection } from "../types/project";
import {
  clipClickSelection,
  inspectKeyOf,
  settleSelection,
  trackClickSelection,
  tracksSelection,
} from "./selection";
import type { DawStore } from "./types";

const localWrites = new WeakMap<() => DawStore, AbortController>();

export function localSelectionWriteSignal(
  getState: () => DawStore,
): AbortSignal {
  let writes = localWrites.get(getState);
  if (!writes) {
    writes = new AbortController();
    localWrites.set(getState, writes);
  }
  return writes.signal;
}

function invalidateLocalSelection(getState: () => DawStore): void {
  const writes = localWrites.get(getState);
  localWrites.delete(getState);
  writes?.abort();
}

type SelectionSlice = Pick<
  DawStore,
  | "selection"
  | "setSelection"
  | "selectClip"
  | "toggleTrackSelected"
  | "selectTracks"
  | "commitRange"
>;

/**
 * The state a new selection implies, shared by local and remote writes. This
 * module is the only one that writes `selection`; every other module spreads
 * this patch (`state/selectionGovernance.test.ts` fails a second writer).
 */
export function selectionPatch(
  current: Selection,
  next: Selection,
  inspectorKey: string | null,
): Pick<DawStore, "selection" | "pendingWireSelection" | "inspectorKey"> {
  const settled = settleSelection(current, next);
  return {
    selection: settled,
    pendingWireSelection: null,
    inspectorKey: inspectorKeyAfter(settled, inspectorKey),
  };
}

function inspectorKeyAfter(
  selection: Selection,
  inspectorKey: string | null,
): string | null {
  return inspectorKey !== null && inspectorKey === inspectKeyOf(selection)
    ? inspectorKey
    : null;
}

/** A new project starts with nothing selected; a wire selection waiting for its target stays. */
export const NO_SELECTION: Pick<DawStore, "selection" | "inspectorKey"> = {
  selection: null,
  inspectorKey: null,
};

/** `next` exactly as given: a click or a set of tracks already worked out the whole selection. */
function exactSelection(
  next: Selection,
  inspectorKey: string | null,
): Pick<DawStore, "selection" | "pendingWireSelection" | "inspectorKey"> {
  return {
    selection: next,
    pendingWireSelection: null,
    inspectorKey: inspectorKeyAfter(next, inspectorKey),
  };
}

export const createSelectionSlice: StateCreator<
  DawStore,
  [],
  [],
  SelectionSlice
> = (set, get) => ({
  selection: null as Selection,
  setSelection: (selection) => {
    invalidateLocalSelection(get);
    set((s) => selectionPatch(s.selection, selection, s.inspectorKey));
  },
  selectClip: (clipId, trackId, mods) => {
    invalidateLocalSelection(get);
    set((s) =>
      exactSelection(
        clipClickSelection(s.selection, s.project, clipId, trackId, mods),
        s.inspectorKey,
      ),
    );
  },
  toggleTrackSelected: (trackId, additive) => {
    invalidateLocalSelection(get);
    set((s) =>
      exactSelection(
        trackClickSelection(s.selection, trackId, additive),
        s.inspectorKey,
      ),
    );
  },
  commitRange: (target) => {
    invalidateLocalSelection(get);
    set((s) => ({
      ...selectionPatch(s.selection, { kind: "range", target }, s.inspectorKey),
      inspectorKey: "range",
      rangeArmed: false,
      rangeDraft: null,
    }));
  },
  selectTracks: (trackIds) => {
    invalidateLocalSelection(get);
    set((s) => exactSelection(tracksSelection(trackIds), s.inspectorKey));
  },
});
