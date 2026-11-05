import type { LaneProps } from "../system/Lane";
import type { TrackView } from "../types/project";
import type { MuteState } from "../utils/audio";
import { laneColorIndex } from "./laneColors";

type LaneSource = {
  track: TrackView;
  trackIndex: number;
  muteState: MuteState;
  height: number;
  width: number;
  zoomPxPerSec: number;
  loading: boolean;
};

/**
 * The lane children are absolute px from the canvas origin until `Clip`
 * takes over placement, so the lane's window is pinned to `start` 0 and the
 * full canvas width.
 */
export function laneProps({
  track,
  trackIndex,
  muteState,
  height,
  width,
  zoomPxPerSec,
  loading,
}: LaneSource): Omit<LaneProps, "children"> {
  return {
    name: track.label || track.id,
    colorIndex: laneColorIndex(track.role, trackIndex),
    height,
    start: 0,
    pxPerSecond: zoomPxPerSec,
    width,
    mute: muteState,
    loading,
  };
}
