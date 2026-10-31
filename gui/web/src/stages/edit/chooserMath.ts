/**
 * Where the target chooser's chips sit for a held point (spec-edit
 * POP-CHOOSER): a shallow fan above the press point, below it near the top of
 * the box, and swung away from a side edge. A copy of the placement rules of
 * the legacy `timeline/chooserLayout.ts` with the spec's numbers (the legacy
 * file stays until the wiring slice retires it; nothing here imports
 * `timeline/`). Every number is in the leaf's own coordinates: the host
 * converts, and pages the targets (at most five are drawn).
 */
import type { Bounds, Point } from "./createMenuLayout";

/** A chip is a 44 px circle (2.75 rem). */
export const CHOOSER_CHIP_PX = 44;
/** How far the middle of the fan sits from the press point, to a chip's centre. */
export const CHOOSER_RISE_PX = 56;
/** Space between two neighbouring chips. */
export const CHOOSER_GAP_PX = 8;
/**
 * How far the outermost chips bend back toward the press point. With the rise
 * and the chip, the outer chips' lower edge is 28 px from the press point, 8 px
 * clear of an assumed 20 px fingertip contact radius.
 */
export const CHOOSER_SAG_PX = 6;
/** Gap kept between a chip or the caption and the box's edges. */
export const CHOOSER_EDGE_PX = 16;
/** Room for the caption on the side of the arc away from the press point. */
export const CHOOSER_ROOM_PX = 48;
/** Half the caption's widest line (15 rem at 16 px). */
export const CHOOSER_CAPTION_HALF_PX = 120;
/** The most chips drawn at once; a longer list is paged by the host. */
export const CHOOSER_MAX_CHIPS = 5;

export type ChipPlacement = "above" | "below";

export type ChipLayout = {
  placement: ChipPlacement;
  /** Each chip's centre, left to right. */
  centers: Point[];
  /** The caption's bottom centre above the arc, or its top centre below it. */
  caption: Point;
};

/** Centres for `count` chips (at most five) around `finger`, inside `bounds`. */
export function layoutChips(
  count: number,
  finger: Point,
  bounds: Bounds,
): ChipLayout {
  const shown = Math.min(count, CHOOSER_MAX_CHIPS);
  const pitch = CHOOSER_CHIP_PX + CHOOSER_GAP_PX;
  const half = (shown - 1) / 2;
  const minX = bounds.left + CHOOSER_EDGE_PX + CHOOSER_CHIP_PX / 2;
  const maxX = bounds.right - CHOOSER_EDGE_PX - CHOOSER_CHIP_PX / 2;
  const first = finger.x - half * pitch;
  const last = finger.x + half * pitch;
  const shift =
    first < minX
      ? minX - first
      : last > maxX
        ? Math.max(minX - first, maxX - last)
        : 0;
  // Each side needs the rise, half a chip and the caption past the press point.
  const need = CHOOSER_RISE_PX + CHOOSER_CHIP_PX / 2 + CHOOSER_ROOM_PX;
  const roomAbove = finger.y - bounds.top - CHOOSER_EDGE_PX;
  const roomBelow = bounds.bottom - CHOOSER_EDGE_PX - finger.y;
  const placement: ChipPlacement =
    roomAbove >= need || roomAbove >= roomBelow ? "above" : "below";
  const rise = placement === "above" ? -CHOOSER_RISE_PX : CHOOSER_RISE_PX;
  const xs = Array.from(
    { length: shown },
    (_, i) => finger.x + (i - half) * pitch + shift,
  );
  const reach = Math.max(pitch, ...xs.map((x) => Math.abs(x - finger.x)));
  const centers = xs.map((x) => {
    const t = (x - finger.x) / reach;
    return {
      x,
      y: finger.y + rise - Math.sign(rise) * CHOOSER_SAG_PX * t * t,
    };
  });
  const middle = (xs[0] + xs[xs.length - 1]) / 2;
  const captionHalf = CHOOSER_CAPTION_HALF_PX + CHOOSER_EDGE_PX;
  return {
    placement,
    centers,
    caption: {
      x: Math.min(
        bounds.right - captionHalf,
        Math.max(bounds.left + captionHalf, middle),
      ),
      y:
        placement === "above"
          ? Math.min(...centers.map((c) => c.y)) -
            CHOOSER_CHIP_PX / 2 -
            CHOOSER_GAP_PX
          : Math.max(...centers.map((c) => c.y)) +
            CHOOSER_CHIP_PX / 2 +
            CHOOSER_GAP_PX,
    },
  };
}
