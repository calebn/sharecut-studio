import type { StateCreator } from "zustand";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { overlayDocumentDrafts } from "../document/pendingDrafts";
import type { EditMode, TrimEdge } from "../edit/clipEdgePreview";
import { trimDraft } from "../edit/ripplePreview";
import { resetServerClock } from "../presence/clock";
import { EMPTY_ROSTER } from "../presence/roster";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { ProjectView } from "../types/project";
import { waveformViewState } from "../utils/waveformViewPref";
import { sessionSecOf } from "../utils/zoom";
import { zoomReclampPatch } from "./storeMath";
import type { DawStore } from "./types";

type TrimTarget = {
  trackId: string;
  clipId: string;
  edge: TrimEdge;
  mode: EditMode;
};
type TrimLifetime = {
  path: string;
  epoch: number;
  authorityPath: string;
  generation: number;
  seq: number;
  authority: ProjectView | null;
};

const HELD_TRIM_OWNER = Symbol("held trim owner");

export type HeldTrimLayer = Readonly<{
  [HELD_TRIM_OWNER]: true;
  token: symbol;
  target: TrimTarget;
  lifetime: TrimLifetime;
  origin: ProjectView;
  preview: ProjectView;
  value: number;
}>;
export type HeldTrimEvent =
  | { kind: "begin"; token: symbol; target: TrimTarget }
  | { kind: "value"; token: symbol; sourceSec: number }
  | { kind: "finish"; token: symbol; disposition: "discard" | "handoff" };
export type HeldTrimResult =
  | { kind: "accepted" }
  | { kind: "gone" }
  | { kind: "awaiting-document" }
  | { kind: "discarded" }
  | {
      kind: "handoff";
      path: string;
      origin: ProjectView;
      preview: ProjectView;
      value: number;
    };

function lifetimeOf(state: DawStore): TrimLifetime {
  return {
    path: state.projectPath,
    epoch: state.projectEpoch,
    authorityPath: documentAuthority.path,
    generation: documentAuthority.generation,
    seq: documentAuthority.seq,
    authority: documentAuthority.project,
  };
}
function ownsLifetime(layer: HeldTrimLayer, state: DawStore): boolean {
  const lifetime = layer.lifetime;
  return (
    state.projectPath === lifetime.path &&
    state.projectEpoch === lifetime.epoch &&
    documentAuthority.path === lifetime.authorityPath &&
    documentAuthority.generation === lifetime.generation &&
    documentAuthority.seq === lifetime.seq &&
    documentAuthority.project === lifetime.authority
  );
}
function currentAuthorityBasis(state: DawStore): ProjectView | null {
  return documentAuthority.path === state.projectPath &&
    documentAuthority.phase.kind === "ready" &&
    documentAuthority.project
    ? overlayDocumentDrafts(documentAuthority.project)
    : null;
}

type ProjectSlice = Pick<
  DawStore,
  | "project"
  | "projectPath"
  | "projectEpoch"
  | "guestMode"
  | "shareCapabilities"
  | "shareAuthor"
  | "heldTrim"
  | "projectEditBasis"
  | "changeHeldTrim"
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
  heldTrim: null,
  projectPath: "",
  projectEpoch: 0,
  guestMode: null as string | null,
  shareCapabilities: null as string[] | null,
  shareAuthor: null as string | null,
  projectEditBasis: () => {
    const state = get();
    const layer = state.heldTrim;
    if (!layer) return state.project;
    return ownsLifetime(layer, state)
      ? overlayDocumentDrafts(layer.origin)
      : currentAuthorityBasis(state);
  },
  changeHeldTrim: (event) => {
    const state = get();
    const layer = state.heldTrim;
    if (
      (layer && layer.token !== event.token) ||
      (!layer && event.kind !== "begin")
    )
      return { kind: "gone" };
    if (layer && !ownsLifetime(layer, state)) {
      const project = currentAuthorityBasis(state);
      if (!project) return { kind: "awaiting-document" };
      state.setProject(project);
      return { kind: "gone" };
    }
    if (event.kind === "begin") {
      if (layer || !state.project) return { kind: "gone" };
      const clip = state.project.clips.tracks[event.target.trackId]?.find(
        (row) => row.id === event.target.clipId,
      );
      if (!clip) return { kind: "gone" };
      set({
        heldTrim: {
          [HELD_TRIM_OWNER]: true,
          token: event.token,
          target: event.target,
          lifetime: lifetimeOf(state),
          origin: state.project,
          preview: state.project,
          value:
            event.target.edge === "in" ? clip.source_start : clip.source_end,
        },
      });
      return { kind: "accepted" };
    }
    if (!layer || layer.token !== event.token) return { kind: "gone" };
    if (event.kind === "value") {
      if (event.sourceSec === layer.value) return { kind: "accepted" };
      const { trackId, clipId, edge, mode } = layer.target;
      const project = trimDraft(
        layer.origin,
        trackId,
        clipId,
        edge,
        event.sourceSec,
        mode,
      );
      set({
        heldTrim: { ...layer, preview: project, value: event.sourceSec },
        project,
        ...zoomReclampPatch(state, sessionSecOf({ project })),
      });
      return { kind: "accepted" };
    }
    if (event.disposition === "discard") {
      const project = overlayDocumentDrafts(layer.origin);
      set({
        heldTrim: null,
        project,
        ...zoomReclampPatch(state, sessionSecOf({ project })),
      });
      return { kind: "discarded" };
    }
    set({ heldTrim: null });
    return {
      kind: "handoff",
      path: layer.lifetime.path,
      origin: layer.origin,
      preview: layer.preview,
      value: layer.value,
    };
  },
  setProject: (project) => {
    set({
      heldTrim: null,
      project,
      ...zoomReclampPatch(get(), sessionSecOf({ project })),
    });
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
      heldTrim: null,
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
