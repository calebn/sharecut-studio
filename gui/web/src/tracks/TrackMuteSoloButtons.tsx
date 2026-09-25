import { execute } from "../commands/execute";
import { SAVED_MUTE_READ_ONLY } from "../commands/trackMix";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { ToggleButton } from "../ui";
import { type MuteState, trackMuteState } from "../utils/audio";

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
  const muteTitle: Record<MuteState, string> = {
    saved: editsMix
      ? "Muted in the mix, for everyone and every export"
      : SAVED_MUTE_READ_ONLY,
    listen: "Muted for you only",
    implied: "Silenced by your solo",
    off: editsMix ? "Mute in the mix" : "Mute for you only",
  };
  const pressed = state === "saved" || state === "listen";
  const muteClass = {
    saved: " mute",
    listen: " mute mute-listen",
    implied: " mute-implied",
    off: "",
  }[state];

  return (
    <>
      <ToggleButton
        pressed={pressed}
        aria-disabled={state === "saved" && !editsMix ? true : undefined}
        className={`trk-btn ui-control--compact${muteClass}`}
        title={muteTitle[state]}
        data-mute-state={state}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "mute"))}
        onClick={() => {
          void execute("track.muteToggle", { trackId }, { skipWhen: true });
        }}
      >
        M
      </ToggleButton>
      <ToggleButton
        pressed={solo}
        className={`trk-btn ui-control--compact${solo ? " solo" : ""}`}
        title={solo ? "Soloed for you only" : "Solo for you only"}
        {...presenceAnchorProps(presenceAnchor("track", trackId, "solo"))}
        onClick={() => {
          void execute("track.soloToggle", { trackId }, { skipWhen: true });
        }}
      >
        S
      </ToggleButton>
    </>
  );
}
