import { execute } from "../commands/execute";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDaw } from "../state/useDaw";
import { ToggleButton } from "../ui";

/** Mute/Solo toggles shared by the track gutter and the inspector sheet mixer. */
export function TrackMuteSoloButtons({ trackId }: { trackId: string }) {
  const { viewerMute, soloTracks, project } = useDaw();
  const track = project?.tracks.find((t) => t.id === trackId);
  const muted = Boolean(viewerMute[trackId]) || Boolean(track?.muted);
  const solo = Boolean(soloTracks[trackId]);

  return (
    <>
      <ToggleButton
        pressed={muted}
        className={`trk-btn ui-control--compact${muted ? " mute" : ""}`}
        title={track?.muted ? "Project muted (viewer mute)" : "Mute"}
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
        title="Solo"
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
