import { create } from "zustand";
import { createPresenceSlice } from "./presenceSlice";
import { createProjectSlice } from "./projectSlice";
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

/** One atomic Zustand store composed from focused state/action slices. */
export const useDawStore = create<DawStore>()(
  dawWrites.middleware((...args) => ({
    ...createProjectSlice(...args),
    ...createTransportSlice(...args),
    ...createPresenceSlice(...args),
    ...createUiSlice(...args),
  })),
);
