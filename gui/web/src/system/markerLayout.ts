import { clamp } from "../utils/math";
import { xAtTime } from "./rulerMath";

export type LaneMarker =
  | {
      kind: "chapter";
      id: string;
      /** Seconds. The flag's pole sits here. */
      start: number;
      title: string;
    }
  | {
      kind: "comment";
      id: string;
      /** Seconds. A point comment's pin is centred here. */
      start: number;
      /** A range comment ends here and draws a bar. */
      end?: number;
      author: string;
    }
  | {
      kind: "clip";
      id: string;
      start: number;
      end: number;
      title: string;
      /** Hatched while proposed, solid once approved. */
      proposed?: boolean;
    };

/** A flag, a pin and the pair of brackets are all this wide at least. */
export const MARKER_GLYPH_PX = 16;
/** The "+N" chip's room, which sits just after the first marker of a stack. */
export const STACK_CHIP_GAP_PX = 2;
export const STACK_CHIP_PX = 40;
/** How far a touch hit area reaches past a marker, where no neighbour is in the way. */
export const MARKER_REACH_PX = 14;
/** Markers further than this outside the window are not drawn. */
const CULL_PX = 64;
/** What a far-off edge is clamped to, so a clip that spans the episode does not become a 20000 px box. */
const CLAMP_PX = 512;

export type PlacedMarker = {
  type: "marker";
  marker: LaneMarker;
  /** Pixels from the lane's left edge, held near the window. */
  left: number;
  right: number;
  /** For a chapter, where its title is cut off: the next marker, or the end of the lane. */
  titleEnd: number;
  /** Whether each edge of a clip is on screen, so a handle that cannot be reached is not drawn. */
  startVisible: boolean;
  endVisible: boolean;
  reachStart: number;
  reachEnd: number;
};

export type PlacedStack = {
  type: "stack";
  /** The markers the first one hides, in time order. */
  hidden: readonly LaneMarker[];
  left: number;
  right: number;
  reachStart: number;
  reachEnd: number;
};

export type PlacedItem = PlacedMarker | PlacedStack;

type Footprint = {
  marker: LaneMarker;
  /** Pixel extent of the marker's drawing, before it is clamped. */
  l: number;
  r: number;
  x0: number;
  x1: number;
};

export function isRange(marker: LaneMarker): boolean {
  return marker.kind === "clip" || (marker.kind === "comment" && spans(marker));
}

function spans(marker: LaneMarker & { kind: "comment" }): boolean {
  return marker.end !== undefined && marker.end > marker.start;
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
      return marker.end !== undefined && marker.end > marker.start
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

const held = (x: number) => clamp(x, -CLAMP_PX, CLAMP_PX * 2);

/**
 * Where each marker of the lane sits in a window that starts at `start`.
 * Markers whose drawings overlap fold into one: the earliest stays and a
 * "+N" chip right after it carries the rest, so every pixel of the lane is
 * one marker's and a press never lands on two. A touch hit area reaches
 * 14 px past a marker but only half the gap to its neighbour, so two hit
 * areas never overlap.
 */
export function layoutMarkers(
  markers: readonly LaneMarker[],
  start: number,
  pxPerSecond: number,
  width: number,
  pinnedId?: string,
): PlacedItem[] {
  const all = markers.map((marker) => footprint(marker, start, pxPerSecond));
  const pinned = all.find((foot) => foot.marker.id === pinnedId);
  const feet = all
    .filter((foot) => foot !== pinned)
    .sort((a, b) => a.l - b.l || a.marker.id.localeCompare(b.marker.id));

  type Group = { head: Footprint; rest: Footprint[] };
  const groups: Group[] = [];
  for (let at = 0; at < feet.length; ) {
    const head = feet[at] as Footprint;
    const rest: Footprint[] = [];
    let next = at + 1;
    while (next < feet.length && (feet[next] as Footprint).l < head.r) {
      rest.push(feet[next] as Footprint);
      next += 1;
    }
    if (rest.length > 0) {
      const limit = Math.max(
        head.r,
        head.l + MARKER_GLYPH_PX + STACK_CHIP_GAP_PX + STACK_CHIP_PX,
      );
      while (next < feet.length && (feet[next] as Footprint).l < limit) {
        rest.push(feet[next] as Footprint);
        next += 1;
      }
    }
    groups.push({ head, rest });
    at = next;
  }

  const place = (head: Footprint, titleEnd: number): PlacedMarker => ({
    type: "marker",
    marker: head.marker,
    left: held(head.l),
    right: held(head.marker.kind === "chapter" ? titleEnd : head.r),
    titleEnd: held(titleEnd),
    startVisible: head.x0 >= -1 && head.x0 <= width + 1,
    endVisible: head.x1 >= -1 && head.x1 <= width + 1,
    reachStart: 0,
    reachEnd: 0,
  });

  const items: PlacedItem[] = [];
  groups.forEach(({ head, rest }, index) => {
    const nextLeft = Math.min(
      groups[index + 1]?.head.l ?? width,
      pinned && pinned.l > head.l ? pinned.l : width,
    );
    const chipLeft = head.l + MARKER_GLYPH_PX + STACK_CHIP_GAP_PX;
    const chipRight = chipLeft + STACK_CHIP_PX;
    const titleEnd = Math.max(
      head.l + MARKER_GLYPH_PX,
      rest.length > 0 ? chipLeft : nextLeft,
    );
    items.push(place(head, titleEnd));
    if (rest.length > 0) {
      items.push({
        type: "stack",
        hidden: rest.map((foot) => foot.marker),
        left: held(chipLeft),
        right: held(chipRight),
        reachStart: 0,
        reachEnd: 0,
      });
    }
  });

  if (pinned) {
    const nextHead = groups.find((group) => group.head.l > pinned.l)?.head.l;
    const at = items.findIndex((item) => item.left > pinned.l);
    items.splice(
      at < 0 ? items.length : at,
      0,
      place(pinned, Math.max(pinned.l + MARKER_GLYPH_PX, nextHead ?? width)),
    );
  }

  const near = items.filter(
    (item) =>
      (item.type === "marker" && item.marker.id === pinnedId) ||
      (item.right >= -CULL_PX && item.left <= width + CULL_PX),
  );
  near.forEach((item, index) => {
    let gapBefore = item.left;
    let gapAfter = width - item.right;
    near.forEach((other, at) => {
      if (at === index) return;
      if (other.right <= item.left) {
        gapBefore = Math.min(gapBefore, item.left - other.right);
      } else if (other.left >= item.right) {
        gapAfter = Math.min(gapAfter, other.left - item.right);
      }
    });
    item.reachStart = clamp(gapBefore / 2, 0, MARKER_REACH_PX);
    item.reachEnd = clamp(gapAfter / 2, 0, MARKER_REACH_PX);
  });

  return near;
}
