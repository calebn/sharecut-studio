/**
 * Magnetic detents for an armed drag (#1051 round 4b): when the dragged
 * target reaches a soft boundary (`edit/nudgeBoundaries.ts`, the same query
 * held nudges and held arrow keys stop at), it stays there while the finger
 * travels up to `DRAG_DETENT_PX` past it, then follows the finger again. A
 * boundary the drag starts on does not catch it. Hard limits are the target's
 * own clamps and always stop it.
 *
 * Works in timeline seconds along the drag's time axis: `t0` is the target's
 * time when it was armed and `x0` its viewport x then.
 */

import {
  firstBoundaryCrossed,
  type SoftBoundary,
} from "../edit/nudgeBoundaries";
import { DRAG_DETENT_PX } from "../hooks/gestureConstants";

export interface DetentTrack {
  readonly t0: number;
  readonly x0: number;
  readonly pxPerSec: number;
  readonly boundaries: readonly SoftBoundary[];
  /** Where the target last went, in timeline seconds. */
  lastSec: number;
  /** The boundary holding the target, if any. */
  held: SoftBoundary | null;
}

export function startDetents(
  t0: number,
  x0: number,
  pxPerSec: number,
  boundaries: readonly SoftBoundary[],
): DetentTrack {
  return { t0, x0, pxPerSec, boundaries, lastSec: t0, held: null };
}

export function detentX(track: DetentTrack, sec: number): number {
  return track.x0 + (sec - track.t0) * track.pxPerSec;
}

export interface DetentStep {
  /** Where the target goes, viewport x. */
  x: number;
  /** The boundary this move caught it at; null if none was caught now. */
  caught: SoftBoundary | null;
  /** This move pulled it off the boundary that held it. */
  released: boolean;
}

/** The finger asks for viewport x `wantX`: where the target goes. */
export function detentMove(track: DetentTrack, wantX: number): DetentStep {
  if (!(track.pxPerSec > 0)) return { x: wantX, caught: null, released: false };
  const wantSec = track.t0 + (wantX - track.x0) / track.pxPerSec;
  if (track.held) {
    const heldX = detentX(track, track.held.sec);
    if (Math.abs(wantX - heldX) <= DRAG_DETENT_PX) {
      return { x: heldX, caught: null, released: false };
    }
    track.held = null;
    track.lastSec = wantSec;
    return { x: wantX, caught: null, released: true };
  }
  const caught = firstBoundaryCrossed(track.lastSec, wantSec, track.boundaries);
  if (caught) {
    track.held = caught;
    track.lastSec = caught.sec;
    return { x: detentX(track, caught.sec), caught, released: false };
  }
  track.lastSec = wantSec;
  return { x: wantX, caught: null, released: false };
}
