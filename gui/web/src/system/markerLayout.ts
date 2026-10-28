import { clamp } from "../utils/math";
import { xAtTime } from "./rulerMath";

export type LaneMarker =
  | {
      kind: "chapter";
      id: string;
      start: number;
      title: string;
    }
  | {
      kind: "comment";
      id: string;
      start: number;
      end?: number;
      author: string;
    }
  | {
      kind: "clip";
      id: string;
      start: number;
      end: number;
      title: string;
      proposed?: boolean;
    };

const MARKER_GLYPH_PX = 16;
const BRACKET_PX = 6;
const STACK_CHIP_GAP_PX = 2;
const STACK_CHIP_PX = 40;
const MARKER_REACH_PX = 14;
const CULL_PX = 64;
/** Keeps a clip that spans the episode from becoming a 20000 px box: a drawing reaches this far past the lane at most. */
const CLAMP_PX = 512;

export type PlacedMarker = {
  type: "marker";
  marker: LaneMarker;
  left: number;
  right: number;
  /** Where a chapter's title is cut off. */
  titleEnd: number;
  startVisible: boolean;
  endVisible: boolean;
  /** A "+N" chip sits just after this marker's start. */
  stacked: boolean;
  reachStart: number;
  reachEnd: number;
};

export type PlacedStack = {
  type: "stack";
  hidden: readonly LaneMarker[];
  left: number;
  right: number;
  reachStart: number;
  reachEnd: number;
};

type PlacedItem = PlacedMarker | PlacedStack;

type Footprint = {
  marker: LaneMarker;
  l: number;
  r: number;
  x0: number;
  x1: number;
};

export function isRange(marker: LaneMarker): boolean {
  return (
    marker.kind === "clip" ||
    (marker.kind === "comment" &&
      marker.end !== undefined &&
      marker.end > marker.start)
  );
}

export function markerEnd(marker: LaneMarker): number {
  return marker.kind === "chapter"
    ? marker.start
    : (marker.end ?? marker.start);
}

function footprint(
  marker: LaneMarker,
  start: number,
  pxPerSecond: number,
): Footprint {
  const x0 = xAtTime(marker.start, start, pxPerSecond);
  const x1 = xAtTime(markerEnd(marker), start, pxPerSecond);
  switch (marker.kind) {
    case "chapter":
      return { marker, l: x0, r: x0 + MARKER_GLYPH_PX, x0, x1 };
    case "comment":
      return isRange(marker)
        ? { marker, l: x0, r: Math.max(x1, x0 + MARKER_GLYPH_PX), x0, x1 }
        : {
            marker,
            l: x0 - MARKER_GLYPH_PX / 2,
            r: x0 + MARKER_GLYPH_PX / 2,
            x0,
            x1: x0,
          };
    case "clip":
      return { marker, l: x0, r: Math.max(x1, x0 + MARKER_GLYPH_PX), x0, x1 };
  }
}

/**
 * Markers whose glyphs overlap fold into one: the earliest stays and a "+N"
 * chip right after it carries the rest, so a press never lands on two. A
 * span (a clip, a range comment) is drawn behind the markers inside it and
 * does not fold them; only its start glyph, its chip and a bracket's end
 * glyph do. Positions are held to the lane plus `CLAMP_PX`, but culling and
 * folding use the true footprint. A touch hit area reaches past a marker by
 * half the gap to its neighbour at most, so two hit areas never overlap.
 */
export function layoutMarkers(
  markers: readonly LaneMarker[],
  start: number,
  pxPerSecond: number,
  width: number,
  pinnedId?: string,
): PlacedItem[] {
  const held = (x: number) => clamp(x, -CLAMP_PX, width + CLAMP_PX);
  const all = markers.map((marker) => footprint(marker, start, pxPerSecond));
  const pinned = all.find((foot) => foot.marker.id === pinnedId);
  const feet = all
    .filter((foot) => foot !== pinned)
    .sort((a, b) => a.l - b.l || a.marker.id.localeCompare(b.marker.id));

  type Group = { head: Footprint; rest: Footprint[] };
  const groups: Group[] = [];
  for (const foot of feet) {
    const last = groups.at(-1);
    if (last) {
      const reach =
        last.head.l +
        (last.rest.length > 0
          ? MARKER_GLYPH_PX + STACK_CHIP_GAP_PX + STACK_CHIP_PX
          : MARKER_GLYPH_PX);
      if (foot.l < reach) {
        last.rest.push(foot);
        continue;
      }
    }
    const bracket = groups.find(
      ({ head }) =>
        head.marker.kind === "clip" &&
        foot.l < head.x1 &&
        foot.l + MARKER_GLYPH_PX > head.x1 - BRACKET_PX,
    );
    if (bracket) bracket.rest.push(foot);
    else groups.push({ head: foot, rest: [] });
  }

  type Open = {
    type: "marker";
    marker: LaneMarker;
    l: number;
    r: number;
    titleEnd: number;
    x0: number;
    x1: number;
    stacked: boolean;
  };
  type OpenStack = {
    type: "stack";
    hidden: readonly LaneMarker[];
    l: number;
    r: number;
    /** Where the head's start glyph ends: the chip's reach stops there, so the head's own edge keeps its hit area. */
    glyphEnd: number;
  };
  const place = (
    head: Footprint,
    titleEnd: number,
    stacked: boolean,
  ): Open => ({
    type: "marker",
    marker: head.marker,
    l: head.l,
    r: head.marker.kind === "chapter" ? titleEnd : head.r,
    titleEnd,
    x0: head.x0,
    x1: head.x1,
    stacked,
  });

  const items: (Open | OpenStack)[] = [];
  groups.forEach(({ head, rest }, index) => {
    const nextLeft = Math.min(
      groups[index + 1]?.head.l ?? width,
      pinned && pinned.l > head.l ? pinned.l : width,
    );
    const chipLeft = head.l + MARKER_GLYPH_PX + STACK_CHIP_GAP_PX;
    const titleEnd = Math.max(
      head.l + MARKER_GLYPH_PX,
      rest.length > 0 ? chipLeft : nextLeft,
    );
    items.push(place(head, titleEnd, rest.length > 0));
    if (rest.length > 0) {
      items.push({
        type: "stack",
        hidden: rest
          .sort((a, b) => a.l - b.l || a.marker.id.localeCompare(b.marker.id))
          .map((foot) => foot.marker),
        l: chipLeft,
        r: chipLeft + STACK_CHIP_PX,
        glyphEnd: head.l + MARKER_GLYPH_PX,
      });
    }
  });

  if (pinned) {
    const nextHead = groups.find((group) => group.head.l > pinned.l)?.head.l;
    const at = items.findIndex((item) => item.l > pinned.l);
    items.splice(
      at < 0 ? items.length : at,
      0,
      place(
        pinned,
        Math.max(pinned.l + MARKER_GLYPH_PX, nextHead ?? width),
        false,
      ),
    );
  }

  const near = items.filter(
    (item) =>
      (item.type === "marker" && item.marker.id === pinnedId) ||
      (item.r >= -CULL_PX && item.l <= width + CULL_PX),
  );
  return near.map((item, index): PlacedItem => {
    let gapBefore = item.type === "stack" ? item.l - item.glyphEnd : item.l;
    let gapAfter = width - item.r;
    near.forEach((other, at) => {
      if (at === index) return;
      if (other.r <= item.l) {
        gapBefore = Math.min(gapBefore, item.l - other.r);
      } else if (other.l >= item.r) {
        gapAfter = Math.min(gapAfter, other.l - item.r);
      }
    });
    const reachStart = clamp(gapBefore / 2, 0, MARKER_REACH_PX);
    const reachEnd = clamp(gapAfter / 2, 0, MARKER_REACH_PX);
    if (item.type === "stack") {
      return {
        type: "stack",
        hidden: item.hidden,
        left: held(item.l),
        right: held(item.r),
        reachStart,
        reachEnd,
      };
    }
    return {
      type: "marker",
      marker: item.marker,
      left: held(item.l),
      right: held(item.r),
      titleEnd: held(item.titleEnd),
      startVisible: item.x0 >= -1 && item.x0 <= width + 1,
      endVisible: item.x1 >= -1 && item.x1 <= width + 1,
      stacked: item.stacked,
      reachStart,
      reachEnd,
    };
  });
}
