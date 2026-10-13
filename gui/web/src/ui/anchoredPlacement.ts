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
 * Fixed-position box for a panel hung off `anchor`: below it when it fits,
 * flipped above when that side has more room, and clamped so every edge stays
 * `margin` inside `viewport`. A panel taller or wider than the room gets a
 * `maxHeight` / `maxWidth` to scroll or wrap inside.
 */
export function placeAnchored(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: PlacementViewport,
  { margin, gap, align }: PlacementOptions,
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
  const side =
    panel.height <= room.below || room.below >= room.above ? "below" : "above";
  const maxHeight = room[side];
  const height = Math.min(panel.height, maxHeight);
  const top =
    side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
  return { left, top, maxHeight, maxWidth, side };
}

/**
 * The visual viewport as a placement box, falling back to the layout
 * viewport. `bottomChrome` (a bottom bar or rail) ends the box at its top.
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
  if (bottomChrome) {
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
