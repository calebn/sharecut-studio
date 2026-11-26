import { initials } from "../presence/colors";
import type { PresencePerson } from "../presence/presencePeople";
import {
  DEFAULT_REM_PX,
  labelInkSpan,
  PLAYHEAD_BLEED_PX,
  type RulerTick,
  tickKey,
  xAtTime,
} from "./rulerMath";

/** The flag is a 16 px circle on the ruler (spec-edit OVL-PRESENCE). Presence sets it as `--sys-presence-flag`, so the CSS and `flagSide` read this one number. */
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
export function flagSide(
  x: number,
  width: number,
  flagWidth: number = FLAG_PX,
): "right" | "left" {
  return x + flagWidth > width ? "left" : "right";
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** The press area of a pill, in rem: a mouse's and a finger's. */
const HIT_MOUSE_REM = 1.5;
const HIT_TOUCH_REM = 2.75;
/** A group pill's 1 px border each side, its padding and the micro font's digit advance. */
const GROUP_BORDER_PX = 2;
const GROUP_PAD_REM = 0.25;
const GROUP_CHAR_REM = 0.375;
const GROUP_COUNT_CAP = 99;
/** A label is covered within this of a flag, and uncovered again beyond the wider one, so a boundary label does not strobe. */
const COVER_PAD_REM = 0.25;
const UNCOVER_PAD_REM = 0.375;

/** The press area's side in px: 24 for a mouse and 44 for a finger at a 16 px root font. */
export function presenceHitPx(
  pointer: "fine" | "coarse",
  rem: number = DEFAULT_REM_PX,
): number {
  return (pointer === "coarse" ? HIT_TOUCH_REM : HIT_MOUSE_REM) * rem;
}

export type PresenceFlagPerson = {
  id: string;
  /** Seconds. */
  time: number;
  /** Whole px in the window, as `presenceX` gives. */
  x: number;
  colorIndex: number;
  initial: string;
};

export type PresenceFlag = {
  /** The members' ids, sorted and joined: the same people always have the same key. */
  key: string;
  /** Left to right. One person is a single flag, two or more a group. */
  people: readonly PresenceFlagPerson[];
  /** The leftmost member's line. */
  x: number;
  side: "right" | "left";
  /** Px in the window. */
  left: number;
  width: number;
  /** The initial of a single flag, or the group's count: `+3`, `99+` past 99. */
  text: string;
};

export type PresenceGeometry = {
  start: number;
  pxPerSecond: number;
  /** The window's width in px. */
  width: number;
  /** The press area's side in px: `presenceHitPx`. */
  hit: number;
  rem?: number;
};

const groupText = (count: number) =>
  count > GROUP_COUNT_CAP ? `${GROUP_COUNT_CAP}+` : `+${count}`;

function flagOf(
  people: readonly PresenceFlagPerson[],
  geometry: PresenceGeometry,
): PresenceFlag {
  const rem = geometry.rem ?? DEFAULT_REM_PX;
  const first = people[0] as PresenceFlagPerson;
  const grouped = people.length > 1;
  const text = grouped ? groupText(people.length) : first.initial;
  const width = grouped
    ? GROUP_BORDER_PX + rem * (2 * GROUP_PAD_REM + GROUP_CHAR_REM * text.length)
    : FLAG_PX;
  const side = flagSide(first.x, geometry.width, width);
  return {
    key: people
      .map((person) => person.id)
      .sort()
      .join(","),
    people,
    x: first.x,
    side,
    left: side === "right" ? first.x + 1 : first.x - 1 - width,
    width,
    text,
  };
}

const pressSpan = (flag: PresenceFlag, hit: number) => {
  const half = Math.max(flag.width, hit) / 2;
  const centre = flag.left + flag.width / 2;
  return { left: centre - half, right: centre + half };
};

/**
 * The flags to draw: one per person, and one group for people whose press areas would overlap.
 * Boxes are tested pair by pair and the groups between two intersecting ones merge,
 * until none intersect, so no two press areas ever overlap and a group never chains by its anchor.
 * People who are not in the window, or have no playhead, draw no flag. Left to right, ties by key.
 */
export function presenceFlags(
  people: readonly PresencePerson[],
  geometry: PresenceGeometry,
): PresenceFlag[] {
  const placed: PresenceFlagPerson[] = [];
  for (const person of people) {
    if (person.playhead === undefined) continue;
    const x = presenceX(person.playhead, geometry.start, geometry.pxPerSecond);
    if (!playheadVisible(x, geometry.width)) continue;
    placed.push({
      id: person.id,
      time: person.playhead,
      x,
      colorIndex: person.colorIndex,
      initial: Array.from(initials(person.name))[0] ?? "",
    });
  }
  placed.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let groups: PresenceFlagPerson[][] = placed.map((person) => [person]);
  for (;;) {
    const flags = groups.map((group) => flagOf(group, geometry));
    const spans = flags.map((flag) => pressSpan(flag, geometry.hit));
    let from = -1;
    let to = -1;
    for (let i = 0; i < flags.length && from < 0; i++) {
      for (let j = flags.length - 1; j > i; j--) {
        const a = spans[i] as { left: number; right: number };
        const b = spans[j] as { left: number; right: number };
        if (a.left < b.right && b.left < a.right) {
          from = i;
          to = j;
          break;
        }
      }
    }
    if (from < 0) {
      return flags.sort(
        (a, b) =>
          a.left - b.left || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
    }
    groups = [
      ...groups.slice(0, from),
      groups.slice(from, to + 1).flat(),
      ...groups.slice(to + 1),
    ];
  }
}

/**
 * The ticks whose label text comes within a flag's box plus a padding: 0.25 rem to cover it,
 * 0.375 rem to let go of one in `covered`. Touching is not covered.
 * A tick with no label is never covered. The flag and tick x are both whole px.
 */
export function coveredTicks(
  ticks: readonly RulerTick[],
  flags: readonly PresenceFlag[],
  rem: number = DEFAULT_REM_PX,
  covered: ReadonlySet<string> = EMPTY_KEYS,
): ReadonlySet<string> {
  if (flags.length === 0) return EMPTY_KEYS;
  const next = new Set<string>();
  for (const tick of ticks) {
    if (tick.label === "") continue;
    const key = tickKey(tick);
    const pad = (covered.has(key) ? UNCOVER_PAD_REM : COVER_PAD_REM) * rem;
    const ink = labelInkSpan(tick, rem);
    if (
      flags.some(
        (flag) =>
          flag.left - pad < ink.right &&
          ink.left < flag.left + flag.width + pad,
      )
    ) {
      next.add(key);
    }
  }
  return next;
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
