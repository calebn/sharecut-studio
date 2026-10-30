import type { MuteState } from "../utils/audio";
import { LANE_HEIGHT, MAX_FIT_LANE_HEIGHT } from "../utils/layout";
import { PLAYHEAD_BLEED_PX, xAtTime } from "./rulerMath";

type ItemBox = { left: number; width: number };

/** A lane is 72 px at the least and 240 px at the most; anything else, or no number, is the least. */
export function clampLaneHeight(px: number | undefined): number {
  if (px === undefined || !Number.isFinite(px)) return LANE_HEIGHT;
  return Math.round(Math.min(MAX_FIT_LANE_HEIGHT, Math.max(LANE_HEIGHT, px)));
}

/** The window start that puts `playhead` at the middle of a `width` px lane, as the phone's fixed playhead does. */
export function windowStartFor(
  playhead: number,
  pxPerSecond: number,
  width: number,
): number {
  return playhead - width / (2 * pxPerSecond);
}

/** Where an item that starts at `at` and runs `duration` seconds sits in a lane whose left edge is `start`. */
export function itemBox(
  at: number,
  duration: number,
  start: number,
  pxPerSecond: number,
): ItemBox {
  return {
    left: xAtTime(at, start, pxPerSecond),
    width: duration * pxPerSecond,
  };
}

/** False when the box lies wholly outside a `width` px lane, with the playhead's bleed as slack. */
export function itemVisible(box: ItemBox, width: number): boolean {
  return (
    box.left + box.width > -PLAYHEAD_BLEED_PX &&
    box.left < width + PLAYHEAD_BLEED_PX
  );
}

/** The words TrackHeader gives the same states, so a lane and its header never disagree. */
export function laneMuteLook(mute: MuteState): {
  silent: boolean;
  description: string;
} {
  switch (mute) {
    case "saved":
      return { silent: true, description: "Muted in the mix" };
    case "listen":
      return { silent: true, description: "Muted for you only" };
    case "implied":
      return {
        silent: true,
        description: "Silent while another track is soloed",
      };
    default:
      return { silent: false, description: "" };
  }
}
