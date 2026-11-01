export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

/** The box a floating panel must stay inside (the visual viewport). */
export interface PlacementViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlacementOptions {
  /** Clear space kept between the panel and every viewport edge. */
  margin: number;
  /** Space between the anchor and the panel. */
  gap: number;
  /** Which anchor edge the panel lines up with before it is clamped. */
  align: "start" | "center" | "end";
  /** The side tried first. It stands while the panel fits there or that side has more room. */
  prefer?: "below" | "above";
}

export interface AnchoredPlacement {
  left: number;
  top: number;
  /** Tallest the panel may be on the chosen side; taller content scrolls. */
  maxHeight: number;
  /** Widest the panel may be; wider content wraps. */
  maxWidth: number;
  side: "below" | "above";
}

/**
 * Fixed-position box for a panel hung off `anchor`: on the preferred side
 * (below by default) when it fits, flipped when the other side has more room,
 * and clamped so every edge stays `margin` inside `viewport`. A panel taller
 * or wider than the room gets a `maxHeight` / `maxWidth` to scroll or wrap
 * inside.
 */
export function placeAnchored(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: PlacementViewport,
  { margin, gap, align, prefer = "below" }: PlacementOptions,
): AnchoredPlacement {
  const minLeft = viewport.left + margin;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const width = Math.min(panel.width, maxWidth);
  const wanted =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.right - width
        : (anchor.left + anchor.right) / 2 - width / 2;
  const left = Math.max(minLeft, Math.min(wanted, minLeft + maxWidth - width));

  const floor = viewport.top + margin;
  const ceiling = viewport.top + viewport.height - margin;
  const room = {
    below: Math.max(0, ceiling - anchor.bottom - gap),
    above: Math.max(0, anchor.top - gap - floor),
  };
  const other = prefer === "below" ? "above" : "below";
  const side =
    panel.height <= room[prefer] || room[prefer] >= room[other]
      ? prefer
      : other;
  const maxHeight = room[side];
  const height = Math.min(panel.height, maxHeight);
  const top =
    side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
  return { left, top, maxHeight, maxWidth, side };
}

export function placeAnchoredExcluding(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: PlacementViewport,
  excluded: AnchorRect,
  within: AnchorRect,
  options: PlacementOptions,
): AnchoredPlacement {
  const placed = placeAnchored(anchor, panel, viewport, options);
  const width = Math.min(panel.width, placed.maxWidth);
  const height = Math.min(panel.height, placed.maxHeight);
  const overlaps =
    placed.left < excluded.right &&
    placed.left + width > excluded.left &&
    placed.top < excluded.bottom &&
    placed.top + height > excluded.top;
  if (!overlaps) return placed;

  const { margin, gap } = options;
  const leftEdge = Math.max(viewport.left, within.left) + margin;
  const rightEdge =
    Math.min(viewport.left + viewport.width, within.right) - margin;
  const topEdge = Math.max(viewport.top, within.top) + margin;
  const bottomEdge =
    Math.min(viewport.top + viewport.height, within.bottom) - margin;
  const fits = (left: number, top: number) =>
    left >= leftEdge &&
    left + panel.width <= rightEdge &&
    top >= topEdge &&
    top + panel.height <= bottomEdge;
  const keepsAbove =
    placed.side !== "above" || placed.top + panel.height <= anchor.top - gap;
  const sides = [excluded.left - gap - panel.width, excluded.right + gap]
    .filter((left) => keepsAbove && fits(left, placed.top))
    .sort((a, b) => Math.abs(a - placed.left) - Math.abs(b - placed.left));
  if (sides[0] !== undefined) return { ...placed, left: sides[0] };

  const clampedLeft = Math.max(
    leftEdge,
    Math.min(placed.left, rightEdge - panel.width),
  );
  const above = excluded.top - gap - panel.height;
  if (fits(clampedLeft, above) && above + panel.height <= anchor.top - gap) {
    return {
      ...placed,
      left: clampedLeft,
      top: above,
      side: "above",
      maxHeight: excluded.top - gap - topEdge,
    };
  }

  const below = Math.min(
    bottomEdge,
    Math.max(topEdge, anchor.bottom + gap, excluded.bottom + gap),
  );
  return {
    ...placed,
    left: clampedLeft,
    top: below,
    side: "below",
    maxHeight: Math.max(0, bottomEdge - below),
    maxWidth: Math.max(0, rightEdge - leftEdge),
  };
}

/** The smallest box holding both `a` and `b`. */
export function unionRect(a: AnchorRect, b: AnchorRect): AnchorRect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

export interface ClearPlacementOptions extends PlacementOptions {
  /** Narrowest a beside-the-column panel may shrink to before falling back. */
  minWidth: number;
}

export interface ClearPlacement extends Omit<AnchoredPlacement, "side"> {
  side: AnchoredPlacement["side"] | "left" | "right";
}

/**
 * `placeAnchored` for a panel that must never cover `clear` (the anchor plus a
 * control such as the join grip). While the panel fits whole above or below
 * the anchor, inside `fullViewport` cut at `chromeTop`, that placement stands.
 * Otherwise the panel goes beside the `clear` column at the full viewport
 * height, on the wider side that is at least `minWidth` wide, with
 * `maxHeight` / `maxWidth` to scroll or wrap inside. With no such side it
 * falls back to the capped vertical placement.
 */
export function placeAnchoredClear(
  anchor: AnchorRect,
  panel: PanelSize,
  fullViewport: PlacementViewport,
  chromeTop: number | null,
  clear: AnchorRect,
  options: ClearPlacementOptions,
): ClearPlacement {
  const { minWidth, ...base } = options;
  const cut =
    chromeTop == null
      ? fullViewport
      : {
          ...fullViewport,
          height: Math.max(
            0,
            Math.min(fullViewport.height, chromeTop - fullViewport.top),
          ),
        };
  const vertical = placeAnchored(anchor, panel, cut, base);
  if (panel.height <= vertical.maxHeight) {
    return vertical;
  }

  const { margin, gap } = base;
  const edgeLeft = fullViewport.left + margin;
  const edgeRight = fullViewport.left + fullViewport.width - margin;
  const leftSpace = Math.max(0, clear.left - gap - edgeLeft);
  const rightSpace = Math.max(0, edgeRight - (clear.right + gap));
  const side = rightSpace >= leftSpace ? "right" : "left";
  const space = side === "right" ? rightSpace : leftSpace;
  if (space < Math.min(minWidth, panel.width)) {
    return vertical;
  }

  const width = Math.min(panel.width, space);
  const left = side === "right" ? clear.right + gap : clear.left - gap - width;
  const floor = fullViewport.top + margin;
  const ceiling = fullViewport.top + fullViewport.height - margin;
  const maxHeight = Math.max(0, ceiling - floor);
  const height = Math.min(panel.height, maxHeight);
  const centre = (anchor.top + anchor.bottom) / 2;
  const top = Math.max(floor, Math.min(centre - height / 2, ceiling - height));
  return { left, top, maxHeight, maxWidth: space, side };
}

/** Inline size limits for a placed panel. */
export interface InlineSizeCaps {
  maxHeight: number;
  maxWidth: number;
}

/**
 * The inline caps a placement needs, or null while the stylesheet caps
 * govern: a panel that fits whole above or below needs none.
 */
export function inlineSizeCaps(
  placed: ClearPlacement,
  panel: PanelSize,
): InlineSizeCaps | null {
  const beside = placed.side === "left" || placed.side === "right";
  if (
    !beside &&
    panel.height <= placed.maxHeight &&
    panel.width <= placed.maxWidth
  ) {
    return null;
  }
  return { maxHeight: placed.maxHeight, maxWidth: placed.maxWidth };
}

/**
 * The visual viewport as a placement box, falling back to the layout
 * viewport. `bottomChrome` (a bottom bar or rail) ends the box at its top,
 * unless it is not rendered: a `display: none` bar reads back top 0, which
 * would end the box at the top of the screen (#2125).
 */
export function visualViewportBox(
  bottomChrome?: Element | null,
): PlacementViewport {
  const vv = window.visualViewport;
  const box = {
    left: vv?.offsetLeft ?? 0,
    top: vv?.offsetTop ?? 0,
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
  };
  if (bottomChrome && bottomChrome.getClientRects().length > 0) {
    const chromeTop = bottomChrome.getBoundingClientRect().top;
    box.height = Math.max(0, Math.min(box.height, chromeTop - box.top));
  }
  return box;
}

/**
 * A length token as CSS px. A custom property reads back as written, so a rem
 * token is scaled by the root font size.
 */
export function tokenPx(element: Element, name: string): number {
  const raw = getComputedStyle(element).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (raw.endsWith("rem")) {
    const root = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return value * (root || 16);
  }
  return value;
}
