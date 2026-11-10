import { clamp } from "../utils/math";

export type InspectorDetent = "dock" | "half" | "full";

export const INSPECTOR_DETENTS: readonly InspectorDetent[] = [
  "dock",
  "half",
  "full",
];

/** The dock is 4 rem, so this is its height at the default root size; the sheet measures the real one. */
export const DOCK_PX = 64;
const HALF_SHARE = 0.5;
const FULL_SHARE = 0.92;
/** Released this far below the dock the sheet is dismissed; a flick dismisses only a sheet that began at the dock. */
const DISMISS_PX = 24;
/** How far ahead a flick carries the sheet. */
const FLICK_MS = 120;

/** The card is 20 rem wide: this is its width at the default root size. */
export const CARD_WIDTH_PX = 320;
const CARD_GAP_PX = 8;
const CARD_EDGE_PX = 8;
const CARD_MAX_SHARE = 0.6;
/** The least a card or a full sheet can be and still show its header and a few rows: 8.75 rem at the default root size. */
export const CARD_MIN_BLOCK_PX = 140;

/** `CARD_MIN_BLOCK_PX` at this root font size; an unreadable root size counts as the default 16 px. */
export function scaledMinBlock(rootPx: number) {
  return CARD_MIN_BLOCK_PX * ((rootPx || 16) / 16);
}

/**
 * Whether a card in a frame this tall (or a full sheet in a slot this tall)
 * holds `minBlock`; below that the Inspector takes the screen. A frame not yet
 * measured counts as fitting.
 */
export function cardFits(height: number, minBlock = CARD_MIN_BLOCK_PX) {
  return height <= 0 || height * CARD_MAX_SHARE >= minBlock;
}

export type InspectorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InspectorBounds = { width: number; height: number };

export type Sample = { t: number; height: number };

type CardPlacement = {
  side: "below" | "above";
  inline: number;
  block: number;
  maxBlock: number;
};

export function detentHeight(
  detent: InspectorDetent,
  container: number,
  dock = DOCK_PX,
) {
  if (detent === "dock") return dock;
  return container * (detent === "half" ? HALF_SHARE : FULL_SHARE);
}

/** The sheet follows the finger from the top of the dock to the full detent, and below the dock down to nothing. */
export function dragHeight(start: number, dy: number, container: number) {
  return clamp(start - dy, 0, detentHeight("full", container));
}

/** A finger held still this long before it lifts carries no flick. */
const STALE_MS = 80;

/** The speed is read across this much of the drag, so two moves handled back to back cannot read as a huge flick. */
export const VELOCITY_WINDOW_MS = 100;

/** Pixels per millisecond, positive when the sheet is rising, from the oldest sample within the velocity window, and zero once the finger has rested. */
export function riseVelocity(samples: readonly Sample[], now: number): number {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > STALE_MS) return 0;
  const from = samples.find(
    (sample) => sample.t < last.t && last.t - sample.t <= VELOCITY_WINDOW_MS,
  );
  if (!from) return 0;
  return (last.height - from.height) / (last.t - from.t);
}

/**
 * The detent the sheet settles on, or `dismiss` when it was let go below the dock
 * or flicked down from the dock. A flick down from higher up lands on the dock.
 */
export function settleDetent(
  height: number,
  velocity: number,
  container: number,
  fromDock = false,
  dock = DOCK_PX,
): InspectorDetent | "dismiss" {
  const projected = height + velocity * FLICK_MS;
  const bar = dock - DISMISS_PX;
  if (height < bar || (fromDock && projected < bar)) return "dismiss";
  let best: InspectorDetent = "dock";
  let bestGap = Number.POSITIVE_INFINITY;
  for (const detent of INSPECTOR_DETENTS) {
    const gap = Math.abs(projected - detentHeight(detent, container, dock));
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
 * The room never takes the card under `minBlock` (8.75 rem at the default root
 * size), so a card squeezed between its anchor and an edge covers the part of
 * the anchor it overlaps. A frame too short for `minBlock` at 60 % (`cardFits`)
 * gets no card: the host takes the screen instead.
 */
export function placeCard(
  anchor: InspectorRect,
  bounds: InspectorBounds,
  cardWidth = CARD_WIDTH_PX,
  minBlock = CARD_MIN_BLOCK_PX,
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
  const maxBlock = Math.min(tallest, Math.max(room, minBlock));
  const edge =
    side === "below"
      ? anchor.y + anchor.height + CARD_GAP_PX
      : bounds.height - anchor.y + CARD_GAP_PX;
  const width = Math.min(cardWidth, bounds.width - 2 * CARD_EDGE_PX);
  const centred = anchor.x + anchor.width / 2 - width / 2;
  return {
    side,
    inline: clamp(
      centred,
      CARD_EDGE_PX,
      Math.max(CARD_EDGE_PX, bounds.width - width - CARD_EDGE_PX),
    ),
    block: clamp(
      edge,
      CARD_EDGE_PX,
      Math.max(CARD_EDGE_PX, bounds.height - CARD_EDGE_PX - maxBlock),
    ),
    maxBlock,
  };
}
