import type { StateCreator } from "zustand";
import { resetDocumentAuthority } from "../document/authorityState";
import { resetServerClock } from "../presence/clock";
import { EMPTY_ROSTER } from "../presence/roster";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { waveformViewState } from "../utils/waveformViewPref";
import { sessionSecOf } from "../utils/zoom";
import { zoomReclampPatch } from "./storeMath";
import type { DawStore } from "./types";

type ProjectSlice = Pick<
  DawStore,
  | "project"
  | "projectPath"
  | "projectEpoch"
  | "guestMode"
  | "shareCapabilities"
  | "shareAuthor"
  | "setProject"
  | "setGuestMode"
  | "setPipelineJob"
  | "pipelineJob"
  | "setActivityJob"
  | "activityJob"
  | "setActivityRunningCount"
  | "activityRunningCount"
  | "hydrate"
>;

export const createProjectSlice: StateCreator<
  DawStore,
  [],
  [],
  ProjectSlice
> = (set, get) => ({
  project: null,
  projectPath: "",
  projectEpoch: 0,
  guestMode: null as string | null,
  shareCapabilities: null as string[] | null,
  shareAuthor: null as string | null,
  setProject: (project) => {
    set({ project, ...zoomReclampPatch(get(), sessionSecOf({ project })) });
  },
  setGuestMode: (guestMode: string | null) => set({ guestMode }),
  setPipelineJob: (pipelineJob: PipelineJobSnapshot | null) =>
    set({ pipelineJob }),
  pipelineJob: null,
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
  ) => {
    const samePath = get().projectPath === projectPath;
    if (!samePath) {
      resetDocumentAuthority(projectPath);
      resetServerClock();
    }
    set({
      projectPath,
      projectEpoch: samePath ? get().projectEpoch : get().projectEpoch + 1,
      project: initialProject,
      guestMode,
      shareCapabilities,
      shareAuthor,
      sessionClients: samePath ? get().sessionClients : EMPTY_ROSTER,
      sessionRosterVersion: samePath ? get().sessionRosterVersion : 0,
      followingClientId: samePath ? get().followingClientId : null,
      localClientId: samePath ? get().localClientId : null,
      followDegraded: samePath ? get().followDegraded : {},
      transcriptTimingRequest: samePath ? get().transcriptTimingRequest : null,
      transcriptInlineEditRequest: null,
      transcriptScrollRequest: samePath ? get().transcriptScrollRequest : null,
      transcriptReviewCursor: samePath ? get().transcriptReviewCursor : null,
      transcriptFindReplaceOpen: samePath
        ? get().transcriptFindReplaceOpen
        : false,
      transcriptViewAnchor: samePath ? get().transcriptViewAnchor : null,
      playbackRate: samePath ? get().playbackRate : 1,
      ingestBusy: false,
      ingestDropTrackId: null,
      // Preserve transport on a same-project shell refresh. A project switch
      // starts a new session and discards the previous project's status (#78).
      ...(samePath
        ? {}
        : {
            sourcePreview: null,
            sourcePreviewPositionSec: null,
            sourcePreviewError: null,
            audioError: null,
            isPlaying: false,
            playheadSec: 0,
            playStartSec: null,
            viewerMute: {},
            soloTracks: {},
            sessionRegion: null,
            lastAgentQuery: null,
            lastAppliedRevision: 0,
            lastAppliedCommandId: null,
            playUntilSec: null,
            highlightStaleRender: false,
            renderPreviewBusy: false,
            chapterAddPending: false,
            // A SetClipJoin that never settled must not block every join badge on the next project.
            openJoinId: null,
            joinMutationInFlight: false,
            rippleTrim: null,
            rangeArmed: false,
            rangeBusy: false,
            bounceRangeTarget: null,
            bounceDialogOpen: false,
            exportDialogOpen: false,
            selection: null,
            // Job-result announcement bookkeeping (#704) is per project: a
            // stale id must not hush a headline on the next project.
            pendingJobResults: {},
            spokenJobResultIds: [],
            // A toast's Undo targets this project's history; never carry it over.
            feedbackToast: null,
            ...waveformViewState(projectPath),
          }),
      ...zoomReclampPatch(get(), sessionSecOf({ project: initialProject })),
    });
  },
});
