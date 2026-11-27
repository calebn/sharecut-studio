import type { StateCreator } from "zustand";
import { resetDocumentAuthority } from "../document/authorityState";
import { onFrozenReviewChange } from "../frozenReview";
import { resetServerClock } from "../presence/clock";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { waveformViewState } from "../utils/waveformViewPref";
import { sessionSecOf } from "../utils/zoom";
import { afterCutAfterProject } from "./afterCutSlice";
import {
  effectiveChosen,
  playbackSpeedAvailable,
  sameProjectRatePatch,
} from "./playbackSpeed";
import { presenceProjectInitial } from "./presenceSlice";
import {
  chapterFollowPatch,
  NO_SELECTION,
  transcriptSelectionFollowPatch,
} from "./selectionSlice";
import { stageProjectInitial } from "./stageSlice";
import { zoomReclampPatch } from "./storeMath";
import { timelineViewportRegistry } from "./timelineViewportRegistry";
import { transportProjectInitial } from "./transportSlice";
import type { DawStore } from "./types";
import { chromeInitial, uiAlwaysInitial, uiProjectInitial } from "./uiSlice";

type ProjectSlice = Pick<
  DawStore,
  | "project"
  | "projectPath"
  | "projectEpoch"
  | "guestMode"
  | "shareCapabilities"
  | "shareTranscriptWords"
  | "shareAuthor"
  | "reviewPeaks"
  | "setReviewPeaks"
  | "projectEditBasis"
  | "setProject"
  | "setGuestMode"
  | "setPipelineJob"
  | "pipelineJob"
  | "setupWaitingProject"
  | "setActivityJob"
  | "activityJob"
  | "setActivityRunningCount"
  | "activityRunningCount"
  | "hydrate"
>;

// Whether speed was available at the last hydrate, so a same-path refresh can tell the frozen status flipped.
let hydratedAvailable: boolean | null = null;

// The one rule for a flip: hydrate (same path) and a frozen-status change with no hydrate (confirmDeadLink -> loadReviewBootstrap) both take the patch here.
function takeAvailabilityFlipPatch(
  s: Parameters<typeof sameProjectRatePatch>[0],
  projectPath: string,
) {
  const was = hydratedAvailable;
  hydratedAvailable = playbackSpeedAvailable(projectPath);
  return sameProjectRatePatch(s, projectPath, was);
}

export const createProjectSlice: StateCreator<
  DawStore,
  [],
  [],
  ProjectSlice
> = (set, get) => {
  onFrozenReviewChange(() => {
    const patch = takeAvailabilityFlipPatch(get(), get().projectPath);
    if (Object.keys(patch).length > 0) set(patch);
  });
  return {
    project: null,
    projectPath: "",
    projectEpoch: 0,
    guestMode: null as string | null,
    shareCapabilities: null as string[] | null,
    shareTranscriptWords: false,
    shareAuthor: null as string | null,
    reviewPeaks: [] as readonly number[],
    projectEditBasis: () => get().project,
    setProject: (project) => {
      set((state) =>
        state.project === project
          ? state
          : {
              project,
              afterCut: afterCutAfterProject(state, project),
              ...chapterFollowPatch(state, project),
              ...transcriptSelectionFollowPatch(state, project),
              ...zoomReclampPatch(state, sessionSecOf({ project })),
            },
      );
    },
    setGuestMode: (guestMode: string | null) => set({ guestMode }),
    setReviewPeaks: (reviewPeaks) =>
      set((s) =>
        s.reviewPeaks.length === 0 && reviewPeaks.length === 0
          ? s
          : { reviewPeaks },
      ),
    setPipelineJob: (pipelineJob: PipelineJobSnapshot | null) =>
      set({ pipelineJob }),
    pipelineJob: null,
    setupWaitingProject: null,
    setActivityJob: (activityJob: PipelineJobSnapshot | null) =>
      set({ activityJob }),
    activityJob: null,
    setActivityRunningCount: (activityRunningCount: number) =>
      set({ activityRunningCount }),
    activityRunningCount: 0,

    hydrate: (
      projectPath,
      initialProject,
      guestMode = null,
      shareCapabilities = null,
      shareAuthor = null,
      shareTranscriptWords = false,
    ) => {
      const samePath = get().projectPath === projectPath;
      const {
        exportRequested,
        transcriptRequested,
        transcriptFindReplaceOpen,
      } = chromeInitial();
      if (!samePath) {
        timelineViewportRegistry.setVisualPan(null);
        timelineViewportRegistry.setLayoutProjection(null);
        resetDocumentAuthority(projectPath);
        resetServerClock();
      }
      const flipPatch = takeAvailabilityFlipPatch(get(), projectPath);
      set({
        projectPath,
        projectEpoch: samePath ? get().projectEpoch : get().projectEpoch + 1,
        setupWaitingProject: samePath ? get().setupWaitingProject : null,
        project: initialProject,
        guestMode,
        shareCapabilities,
        shareTranscriptWords,
        shareAuthor,
        ...uiAlwaysInitial(),
        // Preserve transport on a same-project shell refresh. A project switch
        // starts a new session and discards the previous project's status (#78).
        ...(samePath
          ? {
              ...flipPatch,
              ...chapterFollowPatch(get(), initialProject),
              ...transcriptSelectionFollowPatch(get(), initialProject),
            }
          : {
              ...presenceProjectInitial(),
              playbackRate: effectiveChosen({
                chosenPlaybackRate: get().chosenPlaybackRate,
                projectPath,
              }),
              ...transportProjectInitial(),
              ...uiProjectInitial(),
              ...stageProjectInitial(guestMode),
              ...NO_SELECTION,
              chrome: {
                ...get().chrome,
                exportRequested,
                transcriptRequested,
                transcriptFindReplaceOpen,
              },
              ...waveformViewState(projectPath),
            }),
        ...zoomReclampPatch(get(), sessionSecOf({ project: initialProject })),
      });
    },
  };
};
