import { execute } from "../commands/execute";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { trackMuteState } from "../utils/audio";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";

/**
 * Mute/Solo toggles shared by the track gutter and the inspector sheet mixer.
 *
 * M is the saved mix mute for the host and editors (solid) and a listen-only
 * mute for other guests (dashed). S is always listen-only. A track your solo
 * silences shows a dashed "implied mute", as in Pro Tools. Solid means
 * everyone and every export; dashed means only you hear it that way.
 */
export function TrackMuteSoloButtons({ trackId }: { trackId: string }) {
  const {
    viewerMute,
    soloTracks,
    project,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    viewerMute: s.viewerMute,
    soloTracks: s.soloTracks,
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const track = project?.tracks.find((t) => t.id === trackId);
  const editsMix = canEditMix(projectPath, guestMode, shareCapabilities);
  const solo = Boolean(soloTracks[trackId]);
  const state = trackMuteState(
    trackId,
    Boolean(track?.muted),
    viewerMute,
    soloTracks,
  );
  return (
    <TrackMuteSoloButtonsView
      trackId={trackId}
      muteState={state}
      solo={solo}
      editsMix={editsMix}
      onMute={() => {
        void execute("track.muteToggle", { trackId }, { skipWhen: true });
      }}
      onSolo={() => {
        void execute("track.soloToggle", { trackId }, { skipWhen: true });
      }}
    />
  );
}
