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
/** Placement sums round-trip through floats; a gap this small is flush. */
const CLEAR_EPSILON = 0.01;
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

function placeCardBlock(
  anchor: InspectorRect,
  height: number,
  minBlock: number,
  top: number,
  bottom: number,
): Omit<CardPlacement, "inline"> {
  const tallest = height * CARD_MAX_SHARE;
  const belowEdge = anchor.y + anchor.height + CARD_GAP_PX;
  const aboveEdge = anchor.y - CARD_GAP_PX;
  const below = bottom - belowEdge;
  const above = aboveEdge - top;
  const side =
    below >= tallest
      ? "below"
      : above >= tallest
        ? "above"
        : below >= above
          ? "below"
          : "above";
  const room = side === "below" ? below : above;
  const maxBlock = Math.min(tallest, Math.max(room, minBlock), bottom - top);
  const block =
    side === "below"
      ? clamp(belowEdge, top, bottom - maxBlock)
      : height - clamp(aboveEdge, top + maxBlock, bottom);
  return { side, block, maxBlock };
}

/**
 * Prefer the normal above/below position. If it covers the anchor or a
 * keep-clear area, slide beside them or place the card in the nearest usable
 * vertical band around the keep-clear areas. Keep the normal position if
 * none can hold a usable card.
 */
export function placeCard(
  anchor: InspectorRect,
  bounds: InspectorBounds,
  cardWidth = CARD_WIDTH_PX,
  minBlock = CARD_MIN_BLOCK_PX,
  keepClear: readonly InspectorRect[] = [],
): CardPlacement {
  const min = CARD_EDGE_PX;
  const bottom = Math.max(min, bounds.height - min);
  const width = Math.min(cardWidth, bounds.width - 2 * min);
  const maxInline = Math.max(min, bounds.width - width - min);
  const inline = clamp(anchor.x + anchor.width / 2 - width / 2, min, maxInline);
  const normal = {
    ...placeCardBlock(anchor, bounds.height, minBlock, min, bottom),
    inline,
  };

  const padded = (rect: InspectorRect) => ({
    left: rect.x - CARD_GAP_PX,
    right: rect.x + rect.width + CARD_GAP_PX,
    top: rect.y - CARD_GAP_PX,
    end: rect.y + rect.height + CARD_GAP_PX,
  });
  const hasArea = (rect: InspectorRect) => rect.width > 0 && rect.height > 0;
  const obstacles = [anchor, ...keepClear].filter(hasArea).map(padded);
  const normalTop =
    normal.side === "below"
      ? normal.block
      : bounds.height - normal.block - normal.maxBlock;
  const clearsAt = (x: number, top: number, height: number) =>
    obstacles.every(
      (o) =>
        x + width <= o.left + CLEAR_EPSILON ||
        x >= o.right - CLEAR_EPSILON ||
        top + height <= o.top + CLEAR_EPSILON ||
        top >= o.end - CLEAR_EPSILON,
    );
  const clearAt = (x: number) => clearsAt(x, normalTop, normal.maxBlock);
  if (clearAt(inline)) return normal;

  const beside = obstacles
    .flatMap((o) => [o.left - width, o.right])
    .filter((x) => x >= min && x <= maxInline && clearAt(x))
    .sort((a, b) => Math.abs(a - inline) - Math.abs(b - inline))[0];
  if (beside !== undefined) return { ...normal, inline: beside };

  const areas = keepClear.filter(hasArea).map(padded);
  const bands = areas.length
    ? [
        [min, Math.min(...areas.map((o) => o.top))],
        [Math.max(...areas.map((o) => o.end)), bottom],
      ]
    : [[min, bottom]];
  const anchorClearance = (placement: Omit<CardPlacement, "inline">) =>
    placement.side === "below"
      ? placement.block - anchor.y - anchor.height
      : placement.block + anchor.y - bounds.height;
  const nearestBand = (floor: number) =>
    bands
      .filter(([start, stop]) => stop - start >= minBlock)
      .map(([start, stop]) => {
        const placement = placeCardBlock(
          anchor,
          bounds.height,
          floor,
          start,
          stop,
        );
        return { placement, clearance: anchorClearance(placement) };
      })
      .filter(({ clearance }) => clearance >= -CLEAR_EPSILON)
      .sort(
        (a, b) =>
          Math.abs(a.clearance - CARD_GAP_PX) -
          Math.abs(b.clearance - CARD_GAP_PX),
      )[0];
  // Half the minimum still shows the header and a field, which beats covering the bar.
  const clear = nearestBand(minBlock) ?? nearestBand(minBlock / 2);
  return clear ? { ...clear.placement, inline } : normal;
}
