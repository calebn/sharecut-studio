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
  /** Viewport y of chrome the panel must stay below when it sits above the anchor. */
  clearTop?: number;
}

export interface AnchoredPlacement {
  left: number;
  top: number;
  /** Tallest the panel may be on the chosen side; taller content scrolls. */
  maxHeight: number;
  /** Widest the panel may be; wider content wraps. */
  maxWidth: number;
  side: "below" | "above";
  /** True when the panel would sit under `clearTop` chrome on both sides. */
  covered: boolean;
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
  { margin, gap, align, prefer = "below", clearTop = 0 }: PlacementOptions,
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

  const floor = Math.max(viewport.top, clearTop) + margin;
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
  const covered = clearTop > 0 && top < clearTop;
  return { left, top, maxHeight, maxWidth, side, covered };
}

export function areaRects(
  elements: readonly (Element | null | undefined)[],
): DOMRect[] {
  return elements
    .flatMap((element) => (element ? [element.getBoundingClientRect()] : []))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
}

/**
 * `placeAnchored`, moved off every `excluded` box: of the positions beside
 * each, above all and below all that hold the whole panel clear of the set,
 * the nearest to the normal placement, keeping its side unless only the other
 * side clears. Failing a spot beside them, a panel below its anchor tucks in
 * between the anchor and the excluded boxes on a quarter of the usual gap.
 * Where none does, the normal placement stands and the panel may cover an
 * excluded box.
 */
export function placeAnchoredExcluding(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: PlacementViewport,
  excluded: readonly AnchorRect[],
  within: AnchorRect,
  options: PlacementOptions,
): AnchoredPlacement {
  const placed = placeAnchored(anchor, panel, viewport, options);
  const width = Math.min(panel.width, placed.maxWidth);
  const height = Math.min(panel.height, placed.maxHeight);
  const hits = (left: number, top: number, w: number, h: number) =>
    excluded.some(
      (rect) =>
        left < rect.right &&
        left + w > rect.left &&
        top < rect.bottom &&
        top + h > rect.top,
    );
  if (!hits(placed.left, placed.top, width, height)) return placed;

  const { margin, gap } = options;
  const leftEdge = Math.max(viewport.left, within.left) + margin;
  const rightEdge =
    Math.min(viewport.left + viewport.width, within.right) - margin;
  const topEdge =
    Math.max(viewport.top, within.top, options.clearTop ?? 0) + margin;
  const bottomEdge =
    Math.min(viewport.top + viewport.height, within.bottom) - margin;
  const fits = (left: number, top: number) =>
    left >= leftEdge &&
    left + panel.width <= rightEdge &&
    top >= topEdge &&
    top + panel.height <= bottomEdge &&
    !hits(left, top, panel.width, panel.height);
  const keepsAbove =
    placed.side !== "above" || placed.top + panel.height <= anchor.top - gap;
  const base = { ...placed, covered: false };
  const sides = excluded
    .flatMap((rect) => [rect.left - gap - panel.width, rect.right + gap])
    .filter((left) => keepsAbove && fits(left, placed.top))
    .map((left) => ({ ...base, left }));

  const clampedLeft = Math.max(
    leftEdge,
    Math.min(placed.left, rightEdge - panel.width),
  );
  const highest = Math.min(...excluded.map((rect) => rect.top));
  const lowest = Math.max(...excluded.map((rect) => rect.bottom));
  const above = highest - gap - panel.height;
  const below = Math.max(topEdge, anchor.bottom + gap, lowest + gap);
  const bands: AnchoredPlacement[] = [];
  if (fits(clampedLeft, above) && above + panel.height <= anchor.top - gap) {
    bands.push({
      ...base,
      left: clampedLeft,
      top: above,
      side: "above",
      maxHeight: highest - gap - topEdge,
    });
  }
  if (fits(clampedLeft, below)) {
    bands.push({
      ...base,
      left: clampedLeft,
      top: below,
      side: "below",
      maxHeight: bottomEdge - below,
      maxWidth: Math.max(0, rightEdge - leftEdge),
    });
  }
  const distance = (at: AnchoredPlacement) =>
    Math.hypot(at.left - placed.left, at.top - placed.top);
  const flipped = (at: AnchoredPlacement) => Number(at.side !== placed.side);
  const tight = gap / 4;
  const between = highest - tight - panel.height;
  if (
    sides.length === 0 &&
    placed.side === "below" &&
    between >= anchor.bottom + tight &&
    fits(clampedLeft, between)
  ) {
    bands.push({ ...base, left: clampedLeft, top: between });
  }
  return (
    [...sides, ...bands].sort(
      (a, b) => flipped(a) - flipped(b) || distance(a) - distance(b),
    )[0] ?? placed
  );
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
  placed: AnchoredPlacement,
  panel: PanelSize,
): InlineSizeCaps | null {
  if (panel.height <= placed.maxHeight && panel.width <= placed.maxWidth) {
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
