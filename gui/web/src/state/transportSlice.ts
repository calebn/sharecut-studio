import type { StateCreator } from "zustand";
import { guestHearsMixOnly } from "../shareMode";
import type { AuditionMode, SessionRegion } from "../types/session";
import { clampToSession } from "../utils/time";
import type { DawStore, PlayAbFollowup } from "./types";

type TransportSlice = Pick<
  DawStore,
  | "playheadSec"
  | "isPlaying"
  | "playStartSec"
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
  | "stopPlayback"
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

/** On a not-playing → playing edge, remember where playback starts (Stop returns there). */
export function playStartPatch(
  s: Pick<DawStore, "isPlaying">,
  playing: boolean,
  atSec: number,
): Partial<Pick<DawStore, "playStartSec">> {
  return playing && !s.isPlaying ? { playStartSec: atSec } : {};
}

/** Where Stop leaves the playhead: the play start, clamped to the current timeline. */
export function stopTargetSec(
  s: Pick<DawStore, "playStartSec" | "playheadSec" | "project">,
): number {
  if (s.playStartSec == null) {
    return s.playheadSec;
  }
  return clampToSession(
    s.playStartSec,
    s.project?.timeline_duration_sec ?? Number.NaN,
  );
}

export const createTransportSlice: StateCreator<
  DawStore,
  [],
  [],
  TransportSlice
> = (set) => ({
  playheadSec: 0,
  isPlaying: false,
  playStartSec: null as number | null,
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
  // A seek while stopped or paused is a new start: Stop no longer rewinds past it.
  setPlayheadSec: (playheadSec) =>
    set((s) =>
      s.isPlaying ? { playheadSec } : { playheadSec, playStartSec: null },
    ),
  setIsPlaying: (isPlaying) =>
    set((s) => ({
      isPlaying,
      ...playStartPatch(s, isPlaying, s.playheadSec),
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
        ...playStartPatch(s, next, s.playheadSec),
        playUntilSec: next ? null : s.playUntilSec,
        playSkipStartSec: next ? null : s.playSkipStartSec,
        playSkipEndSec: next ? null : s.playSkipEndSec,
        playAbFollowup: next ? null : s.playAbFollowup,
      };
    }),
  stopPlayback: () =>
    set((s) => ({
      isPlaying: false,
      playheadSec: stopTargetSec(s),
      playStartSec: null,
    })),
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
      playStartSec: playheadSec,
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
