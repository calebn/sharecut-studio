import { runPointerCommand } from "../commands/pointer";
import { displayShortcutFor } from "../keymap/registry";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";
import { useTrackMuteState } from "./useTrackMuteState";

/**
 * Mute/Solo toggles shared by the track gutter and the inspector sheet mixer.
 *
 * M is the saved mix mute for the host and editors (solid) and a listen-only
 * mute for other guests (dashed). S is always listen-only. A track your solo
 * silences shows a dashed "implied mute", as in Pro Tools. Solid means
 * everyone and every export; dashed means only you hear it that way.
 */
export function TrackMuteSoloButtons({ trackId }: { trackId: string }) {
  const { solo, project, projectPath, guestMode, shareCapabilities } = useDaw(
    (s) => ({
      solo: Boolean(s.soloTracks[trackId]),
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }),
  );
  const track = project?.tracks.find((t) => t.id === trackId);
  const editsMix = canEditMix(projectPath, guestMode, shareCapabilities);
  const state = useTrackMuteState(trackId, Boolean(track?.muted));
  return (
    <TrackMuteSoloButtonsView
      trackId={trackId}
      trackLabel={track?.label || trackId}
      muteState={state}
      solo={solo}
      editsMix={editsMix}
      shortcuts={{
        mute: displayShortcutFor("track.muteToggle") ?? "",
        solo: displayShortcutFor("track.soloToggle") ?? "",
      }}
      onMute={() => {
        runPointerCommand("track.muteToggle", { trackId });
      }}
      onSolo={() => {
        runPointerCommand("track.soloToggle", { trackId });
      }}
    />
  );
}
