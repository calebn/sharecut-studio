import type { StateCreator } from "zustand";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { sameBasis } from "../document/editBasisKey";
import { overlayDocumentDrafts } from "../document/pendingDrafts";
import type { EditMode, TrimEdge } from "../edit/clipEdgePreview";
import { trimDraft } from "../edit/ripplePreview";
import { resetServerClock } from "../presence/clock";
import { hasShareCapability, isShareProjectKey } from "../shareMode";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { ProjectView } from "../types/project";
import { waveformViewState } from "../utils/waveformViewPref";
import { sessionSecOf } from "../utils/zoom";
import { presenceProjectInitial } from "./presenceSlice";
import { NO_SELECTION } from "./selectionSlice";
import { zoomReclampPatch } from "./storeMath";
import { timelineViewportRegistry } from "./timelineViewportRegistry";
import { transportProjectInitial } from "./transportSlice";
import type { DawStore } from "./types";
import { chromeInitial, uiAlwaysInitial, uiProjectInitial } from "./uiSlice";

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
  token: string | null;
  authority: ProjectView | null;
};

const HELD_TRIM_OWNER = Symbol("held trim owner");

export type HeldTrimLayer = Readonly<{
  [HELD_TRIM_OWNER]: true;
  token: symbol;
  phase: "held" | "saving";
  target: TrimTarget;
  lifetime: TrimLifetime;
  origin: ProjectView;
  preview: ProjectView;
  value: number;
}>;
export type HeldTrimEvent =
  | { kind: "begin"; token: symbol; target: TrimTarget }
  | { kind: "settle"; token: symbol }
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
    token: documentAuthority.token,
    authority: documentAuthority.project,
  };
}
function sameDocument(layer: HeldTrimLayer, state: DawStore): boolean {
  const lifetime = layer.lifetime;
  return (
    state.projectPath === lifetime.path &&
    state.projectEpoch === lifetime.epoch &&
    documentAuthority.path === lifetime.authorityPath &&
    documentAuthority.generation === lifetime.generation &&
    documentAuthority.seq === lifetime.seq &&
    documentAuthority.token === lifetime.token
  );
}
function ownsLifetime(layer: HeldTrimLayer, state: DawStore): boolean {
  return (
    sameDocument(layer, state) &&
    documentAuthority.project === layer.lifetime.authority
  );
}
// A same-seq hydration swaps only late fields, so the trim survives it.
function rebaseHeldTrim(
  layer: HeldTrimLayer,
  state: DawStore,
  project: ProjectView,
): HeldTrimLayer | null {
  if (
    !sameDocument(layer, state) ||
    documentAuthority.project === layer.lifetime.authority ||
    !sameBasis(documentAuthority.project, layer.lifetime.authority)
  )
    return null;
  const { trackId, clipId, edge, mode } = layer.target;
  return {
    ...layer,
    origin: project,
    preview:
      layer.preview === layer.origin
        ? project
        : trimDraft(project, trackId, clipId, edge, layer.value, mode),
    lifetime: { ...layer.lifetime, authority: documentAuthority.project },
  };
}
export function ownsSavingTrim(state: DawStore, token: symbol): boolean {
  const layer = state.heldTrim;
  return (
    !!layer &&
    layer.token === token &&
    layer.phase === "saving" &&
    ownsLifetime(layer, state)
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
    if (event.kind === "settle") {
      if (!layer || layer.phase !== "saving" || !ownsLifetime(layer, state))
        return { kind: "gone" };
      const project = overlayDocumentDrafts(layer.origin);
      set({
        heldTrim: null,
        project,
        ...zoomReclampPatch(state, sessionSecOf({ project })),
      });
      return { kind: "discarded" };
    }
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
          phase: "held",
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
    if (layer.phase !== "held") return { kind: "gone" };
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
    set({ heldTrim: { ...layer, phase: "saving" } });
    return {
      kind: "handoff",
      path: layer.lifetime.path,
      origin: layer.origin,
      preview: layer.preview,
      value: layer.value,
    };
  },
  setProject: (project) => {
    set((state) => {
      if (state.heldTrim === null && state.project === project) return state;
      const held = state.heldTrim
        ? rebaseHeldTrim(state.heldTrim, state, project)
        : null;
      const shown = held ? held.preview : project;
      return {
        heldTrim: held,
        project: shown,
        ...zoomReclampPatch(state, sessionSecOf({ project: shown })),
      };
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
    const { bounceDialogOpen, exportDialogOpen, transcriptFindReplaceOpen } =
      chromeInitial();
    if (!samePath) {
      timelineViewportRegistry.setVisualPan(null);
      timelineViewportRegistry.setLayoutProjection(null);
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
      ...uiAlwaysInitial(),
      // Preserve transport on a same-project shell refresh. A project switch
      // starts a new session and discards the previous project's status (#78).
      ...(samePath
        ? {}
        : {
            ...presenceProjectInitial(),
            ...transportProjectInitial(),
            ...uiProjectInitial(),
            ...NO_SELECTION,
            chrome: {
              ...get().chrome,
              bounceDialogOpen,
              exportDialogOpen,
              transcriptFindReplaceOpen,
            },
            ...waveformViewState(projectPath),
            // Commenting is the job of a Commenter or Editor link, so its
            // guest opens on the Comments tab and its comment field.
            ...(isShareProjectKey(projectPath) &&
            hasShareCapability(shareCapabilities, "comment")
              ? {
                  activeTab: "comments" as const,
                  // The drawer may have been left collapsed in this browser.
                  layoutMode: "default" as const,
                }
              : {}),
          }),
      ...zoomReclampPatch(get(), sessionSecOf({ project: initialProject })),
    });
  },
});
