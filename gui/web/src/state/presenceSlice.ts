import type { StateCreator } from "zustand";
import {
  applyPresenceDelta as applyPresenceDeltaToRoster,
  EMPTY_ROSTER,
  rosterEntry,
  rosterFromList,
} from "../presence/roster";
import { selectionFromWire, selectionToWire } from "../session/wire";
import { guestHearsMixOnly } from "../shareMode";
import type { SessionState, ViewerSessionSnapshot } from "../types/session";
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
  | "suppressPublish"
  | "_suppressTimer"
  | "applyAgentSession"
  | "buildViewerSnapshot"
>;

export const createPresenceSlice: StateCreator<
  DawStore,
  [],
  [],
  PresenceSlice
> = (set, get) => ({
  sessionClients: EMPTY_ROSTER,
  sessionRosterVersion: 0,
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
  localClientId: null as string | null,
  setLocalClientId: (localClientId) => set({ localClientId }),
  followingClientId: null as string | null,
  followDegraded: {} as DawState["followDegraded"],
  setFollowDegraded: (followDegraded) => set({ followDegraded }),
  transcriptViewAnchor: null as string | null,
  setTranscriptViewAnchor: (transcriptViewAnchor) =>
    set({ transcriptViewAnchor }),
  transcriptScrollRequest: null as string | null,
  setTranscriptScrollRequest: (transcriptScrollRequest) =>
    set({ transcriptScrollRequest }),
  playbackRate: 1,
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
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
  lastAppliedRevision: 0,
  lastAppliedCommandId: null as string | null,
  suppressPublish: false,
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
      const nextSel = selectionFromWire(
        state.selection,
        get().project?.envelopes,
      );
      set({
        suppressPublish: true,
        _suppressTimer: timer,
        lastAppliedRevision: state.server_seq,
        lastAppliedCommandId: state.last_command_id,
        playheadSec: state.playhead_sec,
        lastAgentQuery: state.query,
        sessionRegion: state.region,
        playUntilSec:
          state.region && state.is_playing ? state.region.end_sec : null,
        playSkipStartSec: null,
        playSkipEndSec: null,
        playAbFollowup: null,
        auditionEpoch: get().auditionEpoch + 1,
        isPlaying: Boolean(state.is_playing),
        ...playStartPatch(get(), Boolean(state.is_playing), state.playhead_sec),
        ...hear,
        ...(state.selection !== undefined ? { selection: nextSel } : {}),
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
    const nextSel = selectionFromWire(
      state.selection,
      get().project?.envelopes,
    );
    set({
      suppressPublish: true,
      _suppressTimer: timer,
      lastAppliedRevision: state.server_seq,
      lastAppliedCommandId: state.last_command_id,
      ...hear,
      ...(nextSel !== undefined && state.selection !== undefined
        ? { selection: nextSel }
        : {}),
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
