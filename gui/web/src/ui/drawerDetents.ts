/**
 * Where a swiped drawer settles (#1051 round 4b): the compact inspector's
 * strip swipes between its detents (peek, half, full). A short or slow drag
 * snaps back; a drag or flick past the threshold moves one detent that way;
 * a drag that takes the sheet most of the way to an end goes there.
 */
import {
  DRAWER_FLICK_PX_PER_MS,
  DRAWER_SWIPE_MIN_PX,
} from "../hooks/gestureConstants";

export interface DrawerRelease<T> {
  detents: readonly T[];
  current: T;
  /** Finger travel, px; negative is up (taller). */
  dyPx: number;
  /** Finger speed at release, px/ms; negative is up. */
  velocity: number;
  /** The sheet's height where the finger let go, and its slot's height. */
  heightPx: number;
  slotPx: number;
}

export function drawerDetentAfter<T>({
  detents,
  current,
  dyPx,
  velocity,
  heightPx,
  slotPx,
}: DrawerRelease<T>): T {
  const at = Math.max(0, detents.indexOf(current));
  const flick = Math.abs(velocity) >= DRAWER_FLICK_PX_PER_MS;
  if (Math.abs(dyPx) < DRAWER_SWIPE_MIN_PX && !flick) return current;
  const up = (flick ? velocity : dyPx) < 0;
  const last = detents.length - 1;
  if (up && slotPx > 0 && heightPx >= 0.75 * slotPx) return detents[last];
  if (!up && slotPx > 0 && heightPx <= 0.25 * slotPx) return detents[0];
  return detents[Math.min(last, Math.max(0, at + (up ? 1 : -1)))];
}
