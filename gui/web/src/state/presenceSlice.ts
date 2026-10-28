import type { StateCreator } from "zustand";
import {
  applyPresenceDelta as applyPresenceDeltaToRoster,
  EMPTY_ROSTER,
  rosterEntry,
  rosterFromList,
} from "../presence/roster";
import { selectionToWire, wireSelectionPatch } from "../session/wire";
import { guestHearsMixOnly } from "../shareMode";
import type { SessionState, ViewerSessionSnapshot } from "../types/session";
import { selectionPatch } from "./selectionSlice";
import { playStartPatch } from "./transportSlice";
import type { DawState, DawStore } from "./types";

type PresenceSlice = Pick<
  DawStore,
  | "sessionClients"
  | "sessionRosterVersion"
  | "setSessionClients"
  | "applyPresenceDelta"
  | "localClientId"
  | "setLocalClientId"
  | "followingClientId"
  | "followDegraded"
  | "setFollowDegraded"
  | "transcriptViewAnchor"
  | "setTranscriptViewAnchor"
  | "transcriptScrollRequest"
  | "setTranscriptScrollRequest"
  | "playbackRate"
  | "setPlaybackRate"
  | "startFollow"
  | "stopFollow"
  | "lastAppliedRevision"
  | "lastAppliedCommandId"
  | "lastAppliedAgentSelectionSeq"
  | "suppressPublish"
  | "pendingWireSelection"
  | "remoteSelectionRevision"
  | "adoptRemoteSelection"
  | "_suppressTimer"
  | "applyAgentSession"
  | "buildViewerSnapshot"
>;

function remoteSelectionPatch(
  state: Pick<DawStore, "selection" | "inspectorKey">,
  wire: ReturnType<typeof wireSelectionPatch>,
  revision: number,
) {
  return {
    ...selectionPatch(state.selection, wire.selection, state.inspectorKey),
    pendingWireSelection: wire.pendingWireSelection,
    remoteSelectionRevision: revision + 1,
  };
}

/** Session state tied to one project; `hydrate` clears it when the project path changes. */
export function presenceProjectInitial() {
  return {
    sessionClients: EMPTY_ROSTER,
    sessionRosterVersion: 0,
    localClientId: null as string | null,
    followingClientId: null as string | null,
    followDegraded: {} as DawState["followDegraded"],
    transcriptViewAnchor: null as string | null,
    transcriptScrollRequest: null as string | null,
    playbackRate: 1,
    lastAppliedRevision: 0,
    lastAppliedCommandId: null as string | null,
    lastAppliedAgentSelectionSeq: 0,
  };
}

export const createPresenceSlice: StateCreator<
  DawStore,
  [],
  [],
  PresenceSlice
> = (set, get) => ({
  ...presenceProjectInitial(),
  setSessionClients: (clients, rosterVersion) =>
    set((s) => ({
      sessionClients: rosterFromList(clients, s.sessionClients),
      sessionRosterVersion: rosterVersion ?? s.sessionRosterVersion,
    })),
  applyPresenceDelta: (authorClientId, changes, rosterVersion) => {
    const s = get();
    const result = applyPresenceDeltaToRoster(
      s.sessionClients,
      s.sessionRosterVersion,
      authorClientId,
      changes,
      rosterVersion,
    );
    if (result.outcome === "applied") {
      set({
        sessionClients: result.roster,
        sessionRosterVersion: result.version,
      });
    }
    return result.outcome === "resync";
  },
  setLocalClientId: (localClientId) => set({ localClientId }),
  setFollowDegraded: (followDegraded) => set({ followDegraded }),
  setTranscriptViewAnchor: (transcriptViewAnchor) =>
    set({ transcriptViewAnchor }),
  setTranscriptScrollRequest: (transcriptScrollRequest) =>
    set({ transcriptScrollRequest }),
  setPlaybackRate: (playbackRate) => {
    if (get().playbackRate !== playbackRate) {
      set({ playbackRate });
    }
  },
  startFollow: (clientId) => {
    const s = get();
    const target = rosterEntry(s.sessionClients, clientId);
    const name = target?.meta?.display_name || target?.label || clientId;
    set({ followingClientId: clientId });
    get().announceStatus(`Following ${name}`);
  },
  stopFollow: (reason) => {
    if (get().followingClientId == null) {
      return;
    }
    set({ followingClientId: null, playbackRate: 1, followDegraded: {} });
    if (reason === "left") {
      get().announceStatus("They left");
    } else {
      get().announceStatus("Stopped following");
    }
  },
  // --- session publish ---
  suppressPublish: false,
  pendingWireSelection: null,
  remoteSelectionRevision: 0,
  adoptRemoteSelection: (selection, pendingWireSelection = null) =>
    set((s) => ({
      ...selectionPatch(s.selection, selection, s.inspectorKey),
      pendingWireSelection,
      remoteSelectionRevision: s.remoteSelectionRevision + 1,
    })),
  _suppressTimer: null,
  applyAgentSession: (state: SessionState) => {
    const prev = get()._suppressTimer;
    if (prev != null) {
      window.clearTimeout(prev);
    }
    const timer = window.setTimeout(() => {
      set({ suppressPublish: false, _suppressTimer: null });
    }, 1200);
    const fromAgent = (state.last_role ?? state.origin) === "agent";
    const agentSelectionSeq = state.agent_selection_seq ?? 0;
    const adoptSelection =
      fromAgent &&
      state.selection !== undefined &&
      agentSelectionSeq > get().lastAppliedAgentSelectionSeq;
    const guestHear = guestHearsMixOnly(get().guestMode);
    const hear = guestHear
      ? { auditionMode: "mix" as const }
      : {
          auditionMode: state.audition_mode,
          viewerMute: state.viewer_mute ?? {},
          soloTracks: state.solo_tracks ?? {},
        };
    // Only agents may remotely drive transport. Viewer echoes/polls update
    // selection-ish fields without stomping local play/pause or auto-stop.
    // Guests hear Full mix only — never copy host audition / mute / solo maps.
    if (fromAgent) {
      set({
        suppressPublish: true,
        _suppressTimer: timer,
        lastAppliedRevision: state.server_seq,
        lastAppliedCommandId: state.last_command_id,
        playheadSec: state.playhead_sec,
        playheadSeekRevision: get().playheadSeekRevision + 1,
        lastAgentQuery: state.query,
        sessionRegion: state.region,
        playUntilSec:
          state.region && state.is_playing ? state.region.end_sec : null,
        isPlaying: Boolean(state.is_playing),
        ...playStartPatch(get(), Boolean(state.is_playing), state.playhead_sec),
        sourcePreview: null,
        sourcePreviewGeneration: get().sourcePreviewGeneration + 1,
        ...hear,
        ...(adoptSelection
          ? {
              ...remoteSelectionPatch(
                get(),
                wireSelectionPatch(state.selection, get().project),
                get().remoteSelectionRevision,
              ),
              lastAppliedAgentSelectionSeq: agentSelectionSeq,
            }
          : {}),
        ...(state.clients
          ? {
              sessionClients: rosterFromList(
                state.clients,
                get().sessionClients,
              ),
              sessionRosterVersion:
                state.roster_version ?? get().sessionRosterVersion,
            }
          : {}),
      });
      return;
    }
    // Every tab keeps its own selection, host or guest. Only an agent's
    // selection (above) or Follow moves it.
    set({
      suppressPublish: true,
      _suppressTimer: timer,
      lastAppliedRevision: state.server_seq,
      lastAppliedCommandId: state.last_command_id,
      ...hear,
      ...(state.clients
        ? {
            sessionClients: rosterFromList(state.clients, get().sessionClients),
            sessionRosterVersion:
              state.roster_version ?? get().sessionRosterVersion,
          }
        : {}),
    });
  },
  buildViewerSnapshot: (): ViewerSessionSnapshot => {
    const s = get();
    const source =
      s.auditionMode === "mix"
        ? "premix"
        : s.auditionMode === "fx"
          ? "processed"
          : "track";
    const snap: ViewerSessionSnapshot = {
      audition_mode: s.auditionMode,
      region: s.sessionRegion,
      source,
      track_id: Object.keys(s.soloTracks).find((k) => s.soloTracks[k]) ?? null,
      query: s.lastAgentQuery,
      selection: selectionToWire(s.selection, s.project?.envelopes),
      viewer_mute: s.viewerMute,
      solo_tracks: s.soloTracks,
      ack_command_id: s.lastAppliedCommandId,
    };
    if (s.followingClientId == null) {
      snap.playhead_sec = s.playheadSec;
      snap.is_playing = s.isPlaying;
    }
    return snap;
  },
});
