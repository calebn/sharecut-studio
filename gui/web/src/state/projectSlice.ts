import type { StateCreator } from "zustand";
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
  ) => {
    const samePath = get().projectPath === projectPath;
    set({
      projectPath,
      projectEpoch: samePath ? get().projectEpoch : get().projectEpoch + 1,
      project: initialProject,
      guestMode,
      shareCapabilities,
      sessionClients: samePath ? get().sessionClients : [],
      followingClientId: samePath ? get().followingClientId : null,
      localClientId: samePath ? get().localClientId : null,
      serverClockOffsetMs: samePath ? get().serverClockOffsetMs : 0,
      followDegraded: samePath ? get().followDegraded : {},
      transcriptScrollRequest: samePath ? get().transcriptScrollRequest : null,
      transcriptViewAnchor: samePath ? get().transcriptViewAnchor : null,
      playbackRate: samePath ? get().playbackRate : 1,
      ingestBusy: false,
      ingestDropTrackId: null,
      // Preserve transport on a same-project shell refresh. A project switch
      // starts a new session and discards the previous project's status (#78).
      ...(samePath
        ? {}
        : {
            audioError: null,
            isPlaying: false,
            playheadSec: 0,
            playStartSec: null,
            viewerMute: {},
            soloTracks: {},
            sessionRegion: null,
            lastAgentQuery: null,
            playUntilSec: null,
            playSkipStartSec: null,
            playSkipEndSec: null,
            playAbFollowup: null,
            auditionEpoch: 0,
            highlightStaleRender: false,
            renderPreviewBusy: false,
            ...waveformViewState(projectPath),
          }),
      ...zoomReclampPatch(get(), sessionSecOf({ project: initialProject })),
    });
  },
});
