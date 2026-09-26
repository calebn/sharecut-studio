import type { StateCreator } from "zustand";
import { guestHearsMixOnly } from "../shareMode";
import type { AuditionMode, SessionRegion } from "../types/session";
import type { DawStore, PlayAbFollowup } from "./types";

type TransportSlice = Pick<
  DawStore,
  | "playheadSec"
  | "isPlaying"
  | "auditionMode"
  | "viewerMute"
  | "soloTracks"
  | "sessionRegion"
  | "lastAgentQuery"
  | "playUntilSec"
  | "playSkipStartSec"
  | "playSkipEndSec"
  | "playAbFollowup"
  | "auditionEpoch"
  | "audioError"
  | "setPlayheadSec"
  | "setIsPlaying"
  | "togglePlaying"
  | "setAuditionMode"
  | "setViewerMuteMap"
  | "setSoloMap"
  | "toggleViewerMute"
  | "toggleSolo"
  | "setPlayUntilSec"
  | "beginAudition"
  | "continueAudition"
  | "setAudioError"
  | "clearSessionRegion"
>;

export const createTransportSlice: StateCreator<
  DawStore,
  [],
  [],
  TransportSlice
> = (set) => ({
  playheadSec: 0,
  isPlaying: false,
  auditionMode: "mix" as AuditionMode,
  viewerMute: {},
  soloTracks: {},
  sessionRegion: null as SessionRegion | null,
  lastAgentQuery: null as string | null,
  playUntilSec: null as number | null,
  playSkipStartSec: null as number | null,
  playSkipEndSec: null as number | null,
  playAbFollowup: null as PlayAbFollowup | null,
  auditionEpoch: 0,
  audioError: null as string | null,
  setPlayheadSec: (playheadSec) => set({ playheadSec }),
  setIsPlaying: (isPlaying) =>
    set((s) => ({
      isPlaying,
      // Local transport owns the clock — clear agent audition auto-stop.
      playUntilSec: isPlaying ? null : s.playUntilSec,
      playSkipStartSec: isPlaying ? null : s.playSkipStartSec,
      playSkipEndSec: isPlaying ? null : s.playSkipEndSec,
      playAbFollowup: isPlaying ? null : s.playAbFollowup,
    })),
  togglePlaying: () =>
    set((s) => {
      const next = !s.isPlaying;
      return {
        isPlaying: next,
        playUntilSec: next ? null : s.playUntilSec,
        playSkipStartSec: next ? null : s.playSkipStartSec,
        playSkipEndSec: next ? null : s.playSkipEndSec,
        playAbFollowup: next ? null : s.playAbFollowup,
      };
    }),
  setAuditionMode: (auditionMode) =>
    set((s) => ({
      auditionMode: guestHearsMixOnly(s.guestMode) ? "mix" : auditionMode,
    })),
  setViewerMuteMap: (viewerMute) => set({ viewerMute }),
  setSoloMap: (soloTracks) => set({ soloTracks }),
  toggleViewerMute: (trackId) =>
    set((s) => ({
      viewerMute: { ...s.viewerMute, [trackId]: !s.viewerMute[trackId] },
    })),
  toggleSolo: (trackId) =>
    set((s) => ({
      soloTracks: { ...s.soloTracks, [trackId]: !s.soloTracks[trackId] },
    })),
  setPlayUntilSec: (playUntilSec) => set({ playUntilSec }),
  beginAudition: ({ playheadSec, untilSec, skip, abFollowup }) =>
    set((s) => ({
      playheadSec,
      isPlaying: true,
      playUntilSec: untilSec,
      playSkipStartSec: skip?.start ?? null,
      playSkipEndSec: skip?.end ?? null,
      playAbFollowup: abFollowup ?? null,
      auditionEpoch: s.auditionEpoch + 1,
    })),
  continueAudition: ({ playheadSec, untilSec, skip }) =>
    set({
      playheadSec,
      isPlaying: true,
      playUntilSec: untilSec,
      playSkipStartSec: skip?.start ?? null,
      playSkipEndSec: skip?.end ?? null,
      playAbFollowup: null,
    }),
  setAudioError: (audioError) => set({ audioError }),
  clearSessionRegion: () =>
    set({
      sessionRegion: null,
      playUntilSec: null,
      playSkipStartSec: null,
      playSkipEndSec: null,
      playAbFollowup: null,
      lastAgentQuery: null,
    }),
});
