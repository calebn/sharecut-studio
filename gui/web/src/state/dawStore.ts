import { create } from "zustand";
import { selectionFromWire } from "../session/wire";
import { createAfterCutSlice } from "./afterCutSlice";
import { withoutResume } from "./commentDraft";
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
    ...createAfterCutSlice(...args),
  })),
);

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

// A Comment tap pauses the episode and promises to play it on afterwards; any
// Play after that, and so the end of the episode, takes the promise back.
useDawStore.subscribe((state, prev) => {
  const { commentDraft } = state;
  if (state.isPlaying && !prev.isPlaying && commentDraft?.resume)
    state.setCommentDraft(withoutResume(commentDraft));
});
