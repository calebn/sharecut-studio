import type { StateCreator } from "zustand";
import type {
  EditSurface,
  ReviewSection,
  StageId,
  StageSheet,
  StageView,
} from "../types/stage";
import {
  readScriptCollapsed,
  readScriptFocus,
  writeLastStage,
  writeScriptCollapsed,
  writeScriptFocus,
} from "../utils/stagePref";
import type { DawStore } from "./types";

export type StageOpenOptions = {
  section?: ReviewSection;
  /** Open this sheet on the new stage. */
  sheet?: StageSheet;
  /** Leave the open sheet up across the switch. */
  keepSheet?: boolean;
};

export interface StageSliceState {
  stage: StageId;
  /** Zoom, scroll and pane offsets each stage left behind. */
  stageViews: Partial<Record<StageId, StageView>>;
  reviewSection: ReviewSection;
  editSurface: EditSurface;
  openSheet: StageSheet | null;
  scriptCollapsed: boolean;
  scriptFocus: boolean;
  /** The landing stage has been chosen for this project, by rule or by the person. */
  landingSettled: boolean;
  /**
   * Switch stage. In one write it saves the leaving stage's view, restores the
   * arriving one's, closes sheets and routes keys; never from an unmount effect.
   */
  setStage: (next: StageId, options?: StageOpenOptions) => void;
  /** Deep link: `setStage` under the name callers use. */
  openStage: (stage: StageId, options?: StageOpenOptions) => void;
  setReviewSection: (section: ReviewSection) => void;
  setEditSurface: (surface: EditSurface) => void;
  setOpenSheet: (sheet: StageSheet | null) => void;
  setScriptCollapsed: (on: boolean) => void;
  setScriptFocus: (on: boolean) => void;
  setPanelScroll: (stage: StageId, key: string, top: number) => void;
  markLandingSettled: () => void;
  resetStageViews: () => void;
}

/** Stage state tied to one project; `hydrate` clears it when the project path changes. */
export function stageProjectInitial() {
  return {
    stage: "edit" as StageId,
    stageViews: {} as Partial<Record<StageId, StageView>>,
    openSheet: null as StageSheet | null,
    landingSettled: false,
  };
}

export const createStageSlice: StateCreator<
  DawStore,
  [],
  [],
  StageSliceState
> = (set, get) => {
  const setStage = (next: StageId, options: StageOpenOptions = {}) => {
    const prev = get().stage;
    set((s) => {
      const sheet = options.sheet ?? (options.keepSheet ? s.openSheet : null);
      const section = options.section ?? s.reviewSection;
      if (next === prev) {
        return { reviewSection: section, openSheet: sheet };
      }
      const saved = s.stageViews[next];
      return {
        stage: next,
        reviewSection: section,
        openSheet: sheet,
        sheetExpanded: false,
        timelineFocused: next === "edit",
        stageViews: {
          ...s.stageViews,
          [prev]: {
            zoomPxPerSec: s.zoomPxPerSec,
            scrollLeft: s.scrollLeft,
            userZoomed: s.userZoomed,
            panelScroll: s.stageViews[prev]?.panelScroll ?? {},
          },
        },
        ...(saved
          ? {
              zoomPxPerSec: saved.zoomPxPerSec,
              scrollLeft: saved.scrollLeft,
              userZoomed: saved.userZoomed,
            }
          : { scrollLeft: 0, userZoomed: false }),
        landingSettled: true,
      };
    });
    if (next !== prev) writeLastStage(get().projectPath, next);
  };

  return {
    ...stageProjectInitial(),
    reviewSection: "comments",
    editSurface: "lanes",
    scriptCollapsed: readScriptCollapsed(),
    scriptFocus: readScriptFocus(),
    setStage,
    openStage: setStage,
    setReviewSection: (reviewSection) => set({ reviewSection }),
    setEditSurface: (editSurface) => set({ editSurface }),
    setOpenSheet: (openSheet) => set({ openSheet }),
    setScriptCollapsed: (scriptCollapsed) => {
      set({ scriptCollapsed });
      writeScriptCollapsed(scriptCollapsed);
    },
    setScriptFocus: (scriptFocus) => {
      set({ scriptFocus });
      writeScriptFocus(scriptFocus);
    },
    setPanelScroll: (stage, key, top) =>
      set((s) => {
        const view = s.stageViews[stage];
        return {
          stageViews: {
            ...s.stageViews,
            [stage]: {
              zoomPxPerSec: view?.zoomPxPerSec ?? s.zoomPxPerSec,
              scrollLeft: view?.scrollLeft ?? 0,
              userZoomed: view?.userZoomed ?? false,
              panelScroll: { ...view?.panelScroll, [key]: top },
            },
          },
        };
      }),
    markLandingSettled: () => set({ landingSettled: true }),
    resetStageViews: () => set({ stageViews: {} }),
  };
};
