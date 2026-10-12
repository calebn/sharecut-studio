export interface PendingActionRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface FloatingSize {
  width: number;
  height: number;
  /** Distance from the card's top to the bottom of its Approve and Reject row. */
  reach: number;
}

export interface PendingActionPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Place review controls outside the selected lane with a scrollable side
 * budget. `viewport.top` is where free space starts (the bottom of the sticky
 * timeline chrome) and `viewport.height` is where it ends (the top of the
 * bottom panel), so the card never sits over either. Returns null when the
 * review actions (`panel.reach`) cannot fit between them, leaving them to the
 * inline controls; a taller card is capped and scrolls.
 */
export function placePendingActionbar(
  anchor: PendingActionRect,
  panel: FloatingSize,
  viewport: { width: number; height: number; top?: number },
  gutter: number,
): PendingActionPlacement | null {
  const floor = (viewport.top ?? 0) + gutter;
  const centeredLeft = anchor.left + anchor.width / 2 - panel.width / 2;
  const left = Math.max(
    gutter,
    Math.min(centeredLeft, viewport.width - gutter - panel.width),
  );
  const topEdge = Math.max(
    floor,
    Math.min(anchor.top, viewport.height - gutter),
  );
  const bottomEdge = Math.max(
    floor,
    Math.min(anchor.bottom, viewport.height - gutter),
  );
  if (panel.reach > viewport.height - gutter - floor) {
    return null;
  }
  const below = Math.max(0, viewport.height - bottomEdge - gutter * 2);
  const above = Math.max(0, topEdge - floor - gutter);
  if (Math.max(above, below) === 0) {
    return null;
  }

  if (panel.height <= below) {
    return { left, top: bottomEdge + gutter, maxHeight: below };
  }
  if (panel.height <= above) {
    return { left, top: topEdge - gutter - panel.height, maxHeight: above };
  }
  if (below >= above) {
    return { left, top: bottomEdge + gutter, maxHeight: below };
  }
  return {
    left,
    top: topEdge - gutter - above,
    maxHeight: above,
  };
}
