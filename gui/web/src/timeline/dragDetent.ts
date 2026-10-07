/**
 * Magnetic detents for an armed drag (#1051 round 4b): when the dragged
 * target reaches a soft boundary (`edit/nudgeBoundaries.ts`, the same query
 * held nudges and held arrow keys stop at), it stays there while the finger
 * travels up to `DRAG_DETENT_PX` past it, then follows the finger again. A
 * boundary the drag starts on does not catch it. Hard limits are the target's
 * own clamps and always stop it.
 *
 * Works in timeline seconds along the drag's time axis: `t0` is the target's
 * time when it was armed and `x0` the viewport x the finger drives it from.
 * A body (a clip) spans `span` seconds from `t0`, and either end catches.
 */

import {
  firstBoundaryCrossed,
  type SoftBoundary,
} from "../edit/nudgeBoundaries";
import { DRAG_DETENT_PX } from "../hooks/gestureConstants";

/** A boundary holding the target, and the target's time while it does. */
interface Hold {
  boundary: SoftBoundary;
  sec: number;
}

export interface DetentTrack {
  readonly t0: number;
  readonly x0: number;
  readonly pxPerSec: number;
  readonly boundaries: readonly SoftBoundary[];
  /** A body's length; 0 for a point or an edge. */
  readonly span: number;
  /** Viewport x of `t0` when armed, where boundaries are drawn from. */
  readonly anchorX: number;
  /** Where the target last went, in timeline seconds. */
  lastSec: number;
  /** The boundary holding the target, if any. */
  held: Hold | null;
}

export function startDetents(
  t0: number,
  x0: number,
  pxPerSec: number,
  boundaries: readonly SoftBoundary[],
  body: { span: number; anchorX: number } = { span: 0, anchorX: x0 },
): DetentTrack {
  return {
    t0,
    x0,
    pxPerSec,
    boundaries,
    ...body,
    lastSec: t0,
    held: null,
  };
}

export function detentX(track: DetentTrack, sec: number): number {
  return track.x0 + (sec - track.t0) * track.pxPerSec;
}

/** Where `boundary` is on screen, in viewport x. */
export function boundaryX(track: DetentTrack, boundary: SoftBoundary): number {
  return track.anchorX + (boundary.sec - track.t0) * track.pxPerSec;
}

export interface DetentStep {
  /** Where the target goes, viewport x. */
  x: number;
  /** The boundary this move caught it at; null if none was caught now. */
  caught: SoftBoundary | null;
  /** This move pulled it off the boundary that held it. */
  released: boolean;
}

/** The first boundary either end of the target meets moving `from` → `to`. */
function firstHold(track: DetentTrack, from: number, to: number): Hold | null {
  const start = firstBoundaryCrossed(from, to, track.boundaries);
  const end =
    track.span > 0
      ? firstBoundaryCrossed(
          from + track.span,
          to + track.span,
          track.boundaries,
        )
      : null;
  const holds = [
    start && { boundary: start, sec: start.sec },
    end && { boundary: end, sec: end.sec - track.span },
  ].filter((hold): hold is Hold => hold != null);
  holds.sort((a, b) => Math.abs(a.sec - from) - Math.abs(b.sec - from));
  return holds[0] ?? null;
}

/** The finger asks for viewport x `wantX`: where the target goes. */
export function detentMove(track: DetentTrack, wantX: number): DetentStep {
  if (!(track.pxPerSec > 0)) return { x: wantX, caught: null, released: false };
  const wantSec = track.t0 + (wantX - track.x0) / track.pxPerSec;
  let released = false;
  if (track.held) {
    const heldX = detentX(track, track.held.sec);
    if (Math.abs(wantX - heldX) <= DRAG_DETENT_PX) {
      return { x: heldX, caught: null, released: false };
    }
    // Pushed off: the move goes on from the boundary, so the next one on the
    // way still catches it.
    track.lastSec = track.held.sec;
    track.held = null;
    released = true;
  }
  const hold = firstHold(track, track.lastSec, wantSec);
  if (hold) {
    track.held = hold;
    track.lastSec = hold.sec;
    return { x: detentX(track, hold.sec), caught: hold.boundary, released };
  }
  track.lastSec = wantSec;
  return { x: wantX, caught: null, released };
}
