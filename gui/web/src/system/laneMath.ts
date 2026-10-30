import type { MuteState } from "../utils/audio";
import {
  LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  MAX_FIT_LANE_HEIGHT,
  RULER_HEIGHT,
} from "../utils/layout";
import { xAtTime } from "./rulerMath";

/** How far a clip may stand outside the window and still be drawn, so its edge handles are not cut at the window's side. */
const CLIP_SLACK_PX = 6;

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

/** False when the box lies wholly outside a `width` px lane, with `CLIP_SLACK_PX` of slack. */
export function itemVisible(box: ItemBox, width: number): boolean {
  return (
    box.left + box.width > -CLIP_SLACK_PX && box.left < width + CLIP_SLACK_PX
  );
}

/** The words TrackHeader gives the same states, so a lane and its header never disagree. */
export function laneMuteLook(mute: MuteState): { description: string } {
  switch (mute) {
    case "saved":
      return { description: "Muted in the mix" };
    case "listen":
      return { description: "Muted for you only" };
    case "implied":
      return { description: "Silent while another track is soloed" };
    default:
      return { description: "" };
  }
}

export type LaneRowBox = { id: string; top: number; height: number };

/**
 * Each lane's top and height in px from the top of the ruler, for the
 * presence overlay. The heights are the ones `Lane` draws (clamped), so the
 * overlay and the lanes cannot disagree; `top` is the ruler plus one marker
 * row unless the stack above the lanes is taller.
 */
export function laneRows(
  lanes: readonly { id: string; height?: number }[],
  top: number = RULER_HEIGHT + MARKER_ROW_HEIGHT,
): LaneRowBox[] {
  let y = top;
  return lanes.map((lane) => {
    const height = clampLaneHeight(lane.height);
    const row = { id: lane.id, top: y, height };
    y += height;
    return row;
  });
}
