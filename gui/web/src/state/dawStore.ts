import { create } from "zustand";
import { selectionFromWire } from "../session/wire";
import { oneWordOf } from "../utils/rangeSelect";
import { createPresenceSlice } from "./presenceSlice";
import { createProjectSlice } from "./projectSlice";
import { createSelectionSlice } from "./selectionSlice";
import { createStageSlice } from "./stageSlice";
import { createTransportSlice } from "./transportSlice";
import type { DawStore } from "./types";
import { createUiSlice } from "./uiSlice";
import { createWriteBatch } from "./writeBatch";

export { zoomReclampPatch } from "./storeMath";
export { estimateTimelineViewportWidth } from "./uiSlice";

const dawWrites = createWriteBatch<DawStore>();

/**
 * Batches every store write made inside `fn` into one commit: one listener
 * notify, with `get()`/`getState()` inside `fn` seeing pending writes
 * (read-your-writes). Used to fold a queued inbound sync frame's handler
 * closures into one render instead of one per `set()` call.
 */
export const batchDawWrites = dawWrites.batch;

/**
 * One atomic Zustand store composed from focused state/action slices.
 * `dawWrites.middleware` must stay its only middleware (see `writeBatch.ts`).
 */
export const useDawStore = create<DawStore>()(
  dawWrites.middleware((...args) => ({
    ...createProjectSlice(...args),
    ...createTransportSlice(...args),
    ...createPresenceSlice(...args),
    ...createSelectionSlice(...args),
    ...createUiSlice(...args),
    ...createStageSlice(...args),
  })),
);

/** A word draft belongs to its project and to the one word still selected. */
useDawStore.subscribe((state) => {
  const entry = state.wordDraft;
  if (!entry) return;
  const word = oneWordOf(state.selection);
  const sameTarget =
    word != null &&
    word.trackId === entry.trackId &&
    word.sourceId === entry.sourceId &&
    word.wordIndex === entry.wordIndex &&
    state.projectPath === entry.projectPath &&
    state.projectEpoch === entry.projectEpoch;
  if (!sameTarget) state.setWordDraft(null);
});

useDawStore.subscribe((state, prev) => {
  const { pendingWireSelection, project } = state;
  if (!pendingWireSelection || !project || project === prev.project) {
    return;
  }
  const selection = selectionFromWire(pendingWireSelection, project);
  if (selection) {
    state.adoptRemoteSelection(selection);
  }
});
