import { PLAYHEAD_BLEED_PX, xAtTime } from "./rulerMath";

/** The flag is a 16 px circle on the ruler (spec-edit OVL-PRESENCE). */
export const FLAG_PX = 16;

export type PresenceBox = {
  left: number;
  right: number;
  startVisible: boolean;
  endVisible: boolean;
};

/** A whole pixel, so a 1 px line stays within half a pixel of the ruler's playhead. */
export function presenceX(
  seconds: number,
  start: number,
  pxPerSecond: number,
): number {
  return Math.round(xAtTime(seconds, start, pxPerSecond));
}

export function playheadVisible(x: number, width: number): boolean {
  return x >= -PLAYHEAD_BLEED_PX && x <= width + PLAYHEAD_BLEED_PX;
}

/** The flag sits right of its line, and left of it when it would pass the window's right edge. */
export function flagSide(x: number, width: number): "right" | "left" {
  return x + FLAG_PX > width ? "left" : "right";
}

/** A selection's span clipped to the window; null when it is empty or wholly outside. */
export function selectionBox(
  start: number,
  end: number,
  windowStart: number,
  pxPerSecond: number,
  width: number,
): PresenceBox | null {
  if (!(end > start)) return null;
  const from = xAtTime(start, windowStart, pxPerSecond);
  const to = xAtTime(end, windowStart, pxPerSecond);
  if (to <= 0 || from >= width) return null;
  return {
    left: Math.max(0, from),
    right: Math.min(width, to),
    startVisible: from >= 0,
    endVisible: to <= width,
  };
}

/** Everyone but the person you follow: you already see what they see. */
export function visiblePeople<T extends { id: string }>(
  people: readonly T[],
  followed: string | null | undefined,
): T[] {
  return people.filter((person) => person.id !== followed);
}
