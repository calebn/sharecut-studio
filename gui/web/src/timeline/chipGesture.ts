/**
 * The finger on an open target chooser (#1051 round 3): when a slide on a chip
 * drags its target, and when it is just the finger moving between chips.
 *
 * The chooser's whole life is idle → open → over-chip → dragging | selecting:
 * `hitRouting` owns idle, open and dragging; this module decides, for a finger
 * that is down while the chips are open, whether it is `away` from every chip
 * or `over` one, and whether its latest move grabs that chip's target.
 *
 * - A chip is armed when it was pressed (the finger came down on it), or when
 *   a finger that slid onto it has stayed within `TOUCH_SLOP_PX` of where it
 *   arrived for `CHIP_SETTLE_MS`.
 * - An armed chip measures the drag from where the finger rests: the press,
 *   or the last point before its first move once armed.
 * - Once the finger is more than `TOUCH_SLOP_PX` from there, the chip grabs
 *   if that move runs along its target's drag axis.
 * - Any other move past the slop (unarmed, or off the axis) starts over
 *   there, unarmed: the finger is passing over the chip, not dragging it.
 * - Entering another chip, or leaving every chip, starts over there.
 */
import { CHIP_SETTLE_MS, TOUCH_SLOP_PX } from "../hooks/gestureConstants";
import type { DragAxis, HitPoint } from "./hitCandidates";

export type ChipFinger =
  | { kind: "away" }
  | {
      kind: "over";
      /** The chip's hit index. */
      index: number;
      /** Where the finger arrived on the chip, or last moved past the slop. */
      anchor: HitPoint;
      /** When it got there (ms). */
      since: number;
      /** The finger came down on this chip, so it is armed at once. */
      pressed: boolean;
      /** The finger's latest point. */
      last: HitPoint;
      /** Where an armed finger rests; a drag is measured from here. */
      rest: HitPoint | null;
    };

export const AWAY: ChipFinger = { kind: "away" };

type OverChip = Extract<ChipFinger, { kind: "over" }>;

function arrive(index: number, at: HitPoint, now: number): OverChip {
  return {
    kind: "over",
    index,
    anchor: at,
    since: now,
    pressed: false,
    last: at,
    rest: null,
  };
}

/** A finger that came down on chip `index`. */
export function pressChip(
  index: number,
  at: HitPoint,
  now: number,
): ChipFinger {
  return { ...arrive(index, at, now), pressed: true, rest: at };
}

/** True when a slide along the axis would grab the chip's target. */
export function isArmed(finger: ChipFinger, now: number): boolean {
  return (
    finger.kind === "over" &&
    (finger.pressed || now - finger.since >= CHIP_SETTLE_MS)
  );
}

/**
 * A move of (`dx`, `dy`) runs along `axis`: for time-only targets it is at
 * least twice as wide as it is tall (within about 27° of horizontal).
 */
export function alongAxis(axis: DragAxis, dx: number, dy: number): boolean {
  if (axis === "xy") return true;
  if (axis === "x") return Math.abs(dx) >= 2 * Math.abs(dy);
  return false;
}

export interface ChipMove {
  finger: ChipFinger;
  /** The move grabbed the target of the chip the finger is over. */
  grab: boolean;
}

const far = (a: HitPoint, b: HitPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y) > TOUCH_SLOP_PX;

/**
 * The finger moved to `at`, over chip `over` (null: no hit chip) whose target
 * drags along `axis`.
 */
export function moveOnChips(
  finger: ChipFinger,
  over: number | null,
  axis: DragAxis,
  at: HitPoint,
  now: number,
): ChipMove {
  if (over == null) return { finger: AWAY, grab: false };
  if (finger.kind === "away" || finger.index !== over) {
    return { finger: arrive(over, at, now), grab: false };
  }
  if (!isArmed(finger, now)) {
    return {
      finger: far(finger.anchor, at)
        ? arrive(over, at, now)
        : { ...finger, last: at },
      grab: false,
    };
  }
  // Armed: the first move since arming leaves from where the finger rested.
  const rest = finger.rest ?? finger.last;
  if (!far(rest, at)) {
    return { finger: { ...finger, last: at, rest }, grab: false };
  }
  if (alongAxis(axis, at.x - rest.x, at.y - rest.y)) {
    return { finger: { ...finger, last: at, rest }, grab: true };
  }
  return { finger: arrive(over, at, now), grab: false };
}
