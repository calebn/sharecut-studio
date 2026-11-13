import type { StateCreator } from "zustand";
import type {
  EditSurface,
  InviteGroup,
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
import { composerPatch, initialSession } from "./composerSession";
import { stageRoleOf, stagesForRole } from "./stageRoutes";
import type { DawStore } from "./types";

/**
 * A Record session target, as `record.setTarget` takes it. Structurally the
 * record module's `SessionTarget`; written out here so the store (which the
 * e2e type-check also loads) does not import the record module.
 */
export type PendingRecordTarget =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "insert"; at_sec: number }
  | {
      kind: "replace";
      from_sec: number;
      to_sec: number;
      track_ids: string[];
      /** The selected words, so the speaker can read the line; never sent. */
      script?: string;
    };

/** The line to read for a Replace over words: kept with the open room while its target is that Replace. */
export type RecordScript = {
  fromSec: number;
  toSec: number;
  trackIds: string[];
  text: string;
};

export type EditWordReveal = Readonly<{
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
  focus?: true;
}>;

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
  /** Which Invite sheet group to open at: the Record links, from the empty Person tile. Cleared when the sheet closes. */
  inviteAt: InviteGroup | null;
  scriptCollapsed: boolean;
  scriptFocus: boolean;
  /** The landing stage has been chosen for this project, by rule or by the person. */
  landingSettled: boolean;
  /**
   * Where Edit asked the next Record session to land (Re-record, Record here).
   * The Record host stage sends it once, when its room is open and unlocked,
   * then clears it. Memory only: a reload drops it. Leaving Record and a
   * project switch drop it too, so it never reaches a later session.
   */
  pendingRecordTarget: PendingRecordTarget | null;
  /**
   * The Review item the Record card's Review pickup asked to open on. The
   * Review queue reads it once when it mounts, then clears it. Leaving for any
   * stage but Review and a project switch drop it. Memory only.
   */
  pendingReviewItem: string | null;
  /**
   * The words under the Session target chip while the room's target is the
   * Replace over this span. Set when the pending target is sent, cleared when
   * the host picks a different target, leaves Record or changes project.
   * Memory only.
   */
  recordScript: RecordScript | null;
  pendingEditWordReveal: EditWordReveal | null;
  /**
   * Switch stage, or deep-link into one with `options`. In one write it saves
   * the leaving stage's view, restores the arriving one's, closes sheets and
   * routes keys; never from an unmount effect.
   */
  openStage: (stage: StageId, options?: StageOpenOptions) => void;
  setPendingRecordTarget: (target: PendingRecordTarget | null) => void;
  setPendingReviewItem: (id: string | null) => void;
  setRecordScript: (script: RecordScript | null) => void;
  requestEditWordReveal: (word: EditWordReveal) => EditWordReveal;
  consumeEditWordReveal: (request: EditWordReveal) => boolean;
  setReviewSection: (section: ReviewSection) => void;
  setEditSurface: (surface: EditSurface) => void;
  setOpenSheet: (sheet: StageSheet | null) => void;
  /** Opens the Invite sheet, at a group when asked. */
  openInvite: (at?: InviteGroup) => void;
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
    inviteAt: null as InviteGroup | null,
    landingSettled: false,
    pendingRecordTarget: null as PendingRecordTarget | null,
    pendingReviewItem: null as string | null,
    recordScript: null as RecordScript | null,
    pendingEditWordReveal: null as EditWordReveal | null,
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
      const revealWord = next === "edit" ? s.pendingEditWordReveal : null;
      const revealPatch = revealWord
        ? { editSurface: "text" as const, scriptCollapsed: false }
        : {};
      const savedEditView = s.stageViews.edit;
      const stageViews =
        revealWord && savedEditView
          ? {
              ...s.stageViews,
              edit: {
                ...savedEditView,
                panelScroll: Object.fromEntries(
                  Object.entries(savedEditView.panelScroll).filter(
                    ([key]) => key !== "script",
                  ),
                ),
              },
            }
          : s.stageViews;
      if (next === prev) {
        return {
          reviewSection: section,
          openSheet: sheet,
          inviteAt: null,
          stageViews,
          ...revealPatch,
          ...(next === "edit" ? {} : { pendingEditWordReveal: null }),
        };
      }
      const saved = s.stageViews[next];
      const viewsWithOutgoingStage = {
        ...stageViews,
        [prev]: {
          zoomPxPerSec: s.zoomPxPerSec,
          scrollLeft: s.scrollLeft,
          userZoomed: s.userZoomed,
          panelScroll: s.stageViews[prev]?.panelScroll ?? {},
        },
      };
      return {
        // A comment draft belongs to the Review stage it opened.
        ...(prev === "review" ? composerPatch(initialSession) : {}),
        // The pending target waits for Record's room, not for a later visit.
        // So does the line to read: it lives only while Record is open.
        ...(next === "record"
          ? {}
          : { pendingRecordTarget: null, recordScript: null }),
        ...(next === "review" ? {} : { pendingReviewItem: null }),
        stage: next,
        reviewSection: section,
        openSheet: sheet,
        inviteAt: null,
        timelineFocused: next === "edit",
        stageViews: viewsWithOutgoingStage,
        ...(saved
          ? {
              zoomPxPerSec: saved.zoomPxPerSec,
              scrollLeft: saved.scrollLeft,
              userZoomed: saved.userZoomed,
            }
          : { scrollLeft: 0, userZoomed: false }),
        landingSettled: true,
        ...revealPatch,
        pendingEditWordReveal: revealWord,
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
    setPendingRecordTarget: (pendingRecordTarget) =>
      set({ pendingRecordTarget }),
    setPendingReviewItem: (pendingReviewItem) => set({ pendingReviewItem }),
    setRecordScript: (recordScript) => set({ recordScript }),
    requestEditWordReveal: (word) => {
      const request = Object.freeze({ ...word });
      set({ pendingEditWordReveal: request });
      return request;
    },
    consumeEditWordReveal: (request) => {
      let consumed = false;
      set((s) => {
        if (s.pendingEditWordReveal !== request) return {};
        consumed = true;
        return { pendingEditWordReveal: null };
      });
      return consumed;
    },
    setReviewSection: (reviewSection) => set({ reviewSection }),
    setEditSurface: (editSurface) => set({ editSurface }),
    setOpenSheet: (openSheet) => set({ openSheet, inviteAt: null }),
    openInvite: (at) => set({ openSheet: "invite", inviteAt: at ?? null }),
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
