import { create } from "zustand";
import { createPresenceSlice } from "./presenceSlice";
import { createProjectSlice } from "./projectSlice";
import { createTransportSlice } from "./transportSlice";
import type { DawStore } from "./types";
import { createUiSlice } from "./uiSlice";

export { zoomReclampPatch } from "./storeMath";
export { estimateTimelineViewportWidth } from "./uiSlice";

/** One atomic Zustand store composed from focused state/action slices. */
export const useDawStore = create<DawStore>()((...args) => ({
  ...createProjectSlice(...args),
  ...createTransportSlice(...args),
  ...createPresenceSlice(...args),
  ...createUiSlice(...args),
}));
