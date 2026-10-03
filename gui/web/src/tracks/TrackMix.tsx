import { useMemo } from "react";
import { runPointerCommand } from "../commands/pointer";
import { displayShortcutFor } from "../keymap/registry";
import { initials } from "../presence/colors";
import { canEditMix, guestHearsMixOnly } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { laneColor } from "../timeline/laneColors";
import type { TrackView } from "../types/project";
import { trackFaderDb, trackMuteState } from "../utils/audio";
import { type MixTrack, TrackMixView } from "./TrackMixView";

export function TrackMix() {
  const {
    tracks,
    projectPath,
    guestMode,
    shareCapabilities,
    viewerMute,
    soloTracks,
  } = useDaw((s) => ({
    tracks: s.project?.tracks,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    viewerMute: s.viewerMute,
    soloTracks: s.soloTracks,
  }));
  const rows = useMemo(
    () => (tracks ? projectMixRows(tracks, viewerMute, soloTracks) : []),
    [tracks, viewerMute, soloTracks],
  );
  if (!tracks) return <TrackMixView state="loading" />;
  return (
    <TrackMixView
      state="ready"
      shortcuts={{
        mute: displayShortcutFor("track.muteToggle") ?? "",
        solo: displayShortcutFor("track.soloToggle") ?? "",
      }}
      rows={rows}
      access={
        canEditMix(projectPath, guestMode, shareCapabilities)
          ? {
              kind: "edit",
              onVolume: (trackId, db) =>
                runPointerCommand("track.setVolume", { trackId, db }),
            }
          : { kind: "listen" }
      }
      preview={guestHearsMixOnly(guestMode) ? "shared-full-mix" : "host"}
      onMute={(trackId) => runPointerCommand("track.muteToggle", { trackId })}
      onSolo={(trackId) => runPointerCommand("track.soloToggle", { trackId })}
    />
  );
}

function projectMixRows(
  tracks: readonly TrackView[],
  viewerMute: Record<string, boolean>,
  soloTracks: Record<string, boolean>,
): readonly MixTrack[] {
  return tracks.map((track, index) => {
    const label = track.label || track.id;
    return {
      id: track.id,
      label,
      initials: initials(label),
      identityColor: laneColor(track.role, index),
      muteState: trackMuteState(
        track.id,
        Boolean(track.muted),
        viewerMute,
        soloTracks,
      ),
      solo: Boolean(soloTracks[track.id]),
      faderDb: trackFaderDb(track),
    };
  });
}
