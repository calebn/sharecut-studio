import { clamp } from "../utils/math";

export type InspectorDetent = "dock" | "half" | "full";

export const INSPECTOR_DETENTS: readonly InspectorDetent[] = [
  "dock",
  "half",
  "full",
];

/** The action dock is the first detent: 64 px (4rem at 16 px). */
export const DOCK_PX = 64;
const HALF_SHARE = 0.5;
const FULL_SHARE = 0.92;
/** Released this far below the dock, or projected there by a flick, the sheet is dismissed. */
export const DISMISS_PX = 24;
/** How far ahead a flick carries the sheet. */
const FLICK_MS = 120;

export const CARD_WIDTH_PX = 320;
export const CARD_GAP_PX = 8;
export const CARD_EDGE_PX = 8;
const CARD_MAX_SHARE = 0.6;

export type InspectorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InspectorBounds = { width: number; height: number };

export type CardPlacement = {
  side: "below" | "above";
  /** Offset from the left edge of the bounds. */
  inline: number;
  /** Offset from the top edge of the bounds (below) or the bottom edge (above). */
  block: number;
  maxBlock: number;
};

export function detentHeight(detent: InspectorDetent, container: number) {
  if (detent === "dock") return DOCK_PX;
  return container * (detent === "half" ? HALF_SHARE : FULL_SHARE);
}

/** The sheet follows the finger from the top of the dock to the full detent, and below the dock down to nothing. */
export function dragHeight(start: number, dy: number, container: number) {
  return clamp(start - dy, 0, detentHeight("full", container));
}

/** A finger held still this long before it lifts carries no flick. */
const STALE_MS = 80;

/** Pixels per millisecond, positive when the sheet is rising, from the last two samples, and zero once the finger has rested. */
export function riseVelocity(
  samples: readonly { t: number; height: number }[],
  now: number,
): number {
  const last = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  if (!last || !prev || last.t <= prev.t || now - last.t > STALE_MS) return 0;
  return (last.height - prev.height) / (last.t - prev.t);
}

/** The detent the sheet settles on, or `dismiss` when it was let go below the dock. */
export function settleDetent(
  height: number,
  velocity: number,
  container: number,
): InspectorDetent | "dismiss" {
  const projected = height + velocity * FLICK_MS;
  if (projected < DOCK_PX - DISMISS_PX) return "dismiss";
  let best: InspectorDetent = "dock";
  let bestGap = Number.POSITIVE_INFINITY;
  for (const detent of INSPECTOR_DETENTS) {
    const gap = Math.abs(projected - detentHeight(detent, container));
    if (gap < bestGap) {
      best = detent;
      bestGap = gap;
    }
  }
  return best;
}

/** A tap on the grip: half and dock swap, and full steps down to half. */
export function toggledDetent(detent: InspectorDetent): InspectorDetent {
  return detent === "dock" ? "half" : detent === "half" ? "dock" : "half";
}

/** One step up or down the detents, held at the ends. */
export function steppedDetent(
  detent: InspectorDetent,
  direction: 1 | -1,
): InspectorDetent {
  const at = INSPECTOR_DETENTS.indexOf(detent) + direction;
  return (
    INSPECTOR_DETENTS[clamp(at, 0, INSPECTOR_DETENTS.length - 1)] ?? detent
  );
}

/**
 * Below the anchor when the card's tallest form (60 % of the bounds) fits
 * there, otherwise above, otherwise on the side with more room, shortened to it.
 */
export function placeCard(
  anchor: InspectorRect,
  bounds: InspectorBounds,
): CardPlacement {
  const tallest = bounds.height * CARD_MAX_SHARE;
  const below =
    bounds.height - (anchor.y + anchor.height) - CARD_GAP_PX - CARD_EDGE_PX;
  const above = anchor.y - CARD_GAP_PX - CARD_EDGE_PX;
  const side =
    below >= tallest
      ? "below"
      : above >= tallest
        ? "above"
        : below >= above
          ? "below"
          : "above";
  const room = Math.max(0, side === "below" ? below : above);
  const width = Math.min(CARD_WIDTH_PX, bounds.width - 2 * CARD_EDGE_PX);
  const centred = anchor.x + anchor.width / 2 - width / 2;
  return {
    side,
    inline: clamp(
      centred,
      CARD_EDGE_PX,
      Math.max(CARD_EDGE_PX, bounds.width - width - CARD_EDGE_PX),
    ),
    block:
      side === "below"
        ? anchor.y + anchor.height + CARD_GAP_PX
        : bounds.height - anchor.y + CARD_GAP_PX,
    maxBlock: Math.min(tallest, room),
  };
}
