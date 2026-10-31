/**
 * Where the Create here menu sits for a held point (spec-edit MENU-CREATE).
 * A pure port of the placement rules of the legacy `timeline/chooserLayout.ts`
 * (the legacy file stays until the wiring slice retires it; nothing here
 * imports `timeline/`): above the point, else below it, else beside it, inside
 * `bounds`, or inside `viewport` when the menu is taller than `bounds`; a menu
 * taller than any room is capped so it scrolls. It keeps 24 px from the point
 * so a finger never covers it, and clear of a fixed playhead at `avoidX`.
 * Every number is in the leaf's own coordinates: the host converts.
 */

/** Gap between the held point and the menu's near edge (px). */
export const CREATE_MENU_GAP_PX = 24;
/** Gap kept to the box's edges (px). */
export const CREATE_MENU_EDGE_PX = 16;
/** Gap between the menu and a fixed playhead it sits beside (px). */
const PLAYHEAD_GAP_PX = 8;

export type Point = { x: number; y: number };

/** The box the menu stays inside. */
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type MenuPlacement = "above" | "below" | "right" | "left";

export type MenuLayout = {
  placement: MenuPlacement;
  left: number;
  top: number;
  /** The menu is taller than any room there is: cap its height to this and let it scroll. */
  maxHeight: number | null;
};

export type MenuSize = { width: number; height: number };

/**
 * The menu's size with nothing capping it: its width, and its content's height
 * plus its border. A capped box reports the capped `offsetHeight`, which hides
 * that its rows overflow.
 */
export function naturalSize(
  box: Pick<
    HTMLElement,
    "offsetWidth" | "offsetHeight" | "clientHeight" | "scrollHeight"
  >,
): MenuSize {
  return {
    width: box.offsetWidth,
    height: box.scrollHeight + (box.offsetHeight - box.clientHeight),
  };
}

const rangeIn = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const crossesPlayhead = (left: number, width: number, avoidX: number | null) =>
  avoidX != null && left < avoidX && left + width > avoidX;

/** Where the menu of `size` sits for `point`, never over it. */
export function layoutMenu(
  point: Point,
  bounds: Bounds,
  size: MenuSize,
  avoidX: number | null,
  viewport: Bounds = bounds,
): MenuLayout {
  for (const box of [bounds, viewport]) {
    const fit = fitIn(point, box, size, avoidX);
    if (fit) return { ...fit, maxHeight: null };
  }
  return capped(point, viewport, size);
}

function fitIn(
  point: Point,
  box: Bounds,
  size: MenuSize,
  avoidX: number | null,
): Omit<MenuLayout, "maxHeight"> | null {
  const need = size.height + CREATE_MENU_GAP_PX;
  const minLeft = box.left + CREATE_MENU_EDGE_PX;
  const maxLeft = box.right - CREATE_MENU_EDGE_PX - size.width;
  const minTop = box.top + CREATE_MENU_EDGE_PX;
  const maxTop = box.bottom - CREATE_MENU_EDGE_PX - size.height;
  if (maxLeft < minLeft || maxTop < minTop) return null;
  const roomAbove = point.y - box.top - CREATE_MENU_EDGE_PX;
  const roomBelow = box.bottom - CREATE_MENU_EDGE_PX - point.y;
  if (roomAbove >= need || roomBelow >= need) {
    let left = point.x - size.width / 2;
    if (crossesPlayhead(left, size.width, avoidX) && avoidX != null) {
      left =
        point.x <= avoidX
          ? avoidX - PLAYHEAD_GAP_PX - size.width
          : avoidX + PLAYHEAD_GAP_PX;
    }
    const above = roomAbove >= need;
    return {
      placement: above ? "above" : "below",
      left: rangeIn(left, minLeft, maxLeft),
      top: above ? point.y - need : point.y + CREATE_MENU_GAP_PX,
    };
  }
  const right = point.x + CREATE_MENU_GAP_PX;
  const left = point.x - CREATE_MENU_GAP_PX - size.width;
  const sides = [
    { placement: "right" as const, left: right, room: maxLeft - right },
    { placement: "left" as const, left, room: left - minLeft },
  ]
    .filter((side) => side.room >= 0)
    .sort(
      (a, b) =>
        Number(crossesPlayhead(a.left, size.width, avoidX)) -
          Number(crossesPlayhead(b.left, size.width, avoidX)) ||
        b.room - a.room,
    );
  const side = sides[0];
  return side
    ? {
        placement: side.placement,
        left: side.left,
        top: rangeIn(point.y - size.height / 2, minTop, maxTop),
      }
    : null;
}

/**
 * The menu is taller than `box` has room for, so it scrolls: beside the point
 * at the box's full height where a side has room for its width, else above or
 * below it, whichever has more room, capped to that room. A gap of
 * `CREATE_MENU_GAP_PX` stays between the menu and the point either way.
 */
function capped(point: Point, box: Bounds, size: MenuSize): MenuLayout {
  const minLeft = box.left + CREATE_MENU_EDGE_PX;
  const maxLeft = Math.max(
    minLeft,
    box.right - CREATE_MENU_EDGE_PX - size.width,
  );
  const right = point.x + CREATE_MENU_GAP_PX;
  const left = point.x - CREATE_MENU_GAP_PX - size.width;
  const roomRight = box.right - CREATE_MENU_EDGE_PX - (right + size.width);
  const roomLeft = left - minLeft;
  if (roomRight >= 0 || roomLeft >= 0) {
    const beside = roomRight >= roomLeft;
    return {
      placement: beside ? "right" : "left",
      left: rangeIn(beside ? right : left, minLeft, maxLeft),
      top: box.top + CREATE_MENU_EDGE_PX,
      maxHeight: Math.max(0, box.bottom - box.top - 2 * CREATE_MENU_EDGE_PX),
    };
  }
  const roomAbove = Math.max(
    0,
    point.y - box.top - CREATE_MENU_EDGE_PX - CREATE_MENU_GAP_PX,
  );
  const roomBelow = Math.max(
    0,
    box.bottom - CREATE_MENU_EDGE_PX - point.y - CREATE_MENU_GAP_PX,
  );
  const above = roomAbove > roomBelow;
  const maxHeight = above ? roomAbove : roomBelow;
  return {
    placement: above ? "above" : "below",
    left: rangeIn(point.x - size.width / 2, minLeft, maxLeft),
    top: above
      ? point.y - CREATE_MENU_GAP_PX - maxHeight
      : point.y + CREATE_MENU_GAP_PX,
    maxHeight,
  };
}
