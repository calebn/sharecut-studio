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
import { stageRoleOf, stagesForRole } from "./stageRoutes";
import type { DawStore } from "./types";

type StageOpenOptions = {
  section?: ReviewSection;
  /** Open this sheet on the new stage. */
  sheet?: StageSheet;
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
   * Switch stage, or deep-link into one with `options`. In one write it saves
   * the leaving stage's view, restores the arriving one's, closes sheets and
   * routes keys; never from an unmount effect.
   */
  openStage: (stage: StageId, options?: StageOpenOptions) => void;
  setReviewSection: (section: ReviewSection) => void;
  setEditSurface: (surface: EditSurface) => void;
  setOpenSheet: (sheet: StageSheet | null) => void;
  setScriptCollapsed: (on: boolean) => void;
  setScriptFocus: (on: boolean) => void;
  setPanelScroll: (stage: StageId, key: string, top: number) => void;
  markLandingSettled: () => void;
}

/** Stage state tied to one project; `hydrate` clears it when the project path changes. */
export function stageProjectInitial(guestMode: string | null = null) {
  return {
    stage: (guestMode == null
      ? "edit"
      : stagesForRole(stageRoleOf(guestMode))[0]) as StageId,
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
  const openStage = (next: StageId, options: StageOpenOptions = {}) => {
    const prev = get().stage;
    set((s) => {
      const sheet = options.sheet ?? null;
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
    if (next !== prev && get().guestMode == null) {
      writeLastStage(get().projectPath, next);
    }
  };

  return {
    ...stageProjectInitial(),
    reviewSection: "queue",
    editSurface: "lanes",
    scriptCollapsed: readScriptCollapsed(),
    scriptFocus: readScriptFocus(),
    openStage,
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
  };
};
