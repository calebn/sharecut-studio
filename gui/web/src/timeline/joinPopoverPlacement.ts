export interface Rect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/**
 * Fixed-position top-left for the join popover: centred under the badge,
 * `marginPx` below it, kept `marginPx` inside the viewport; flips above the
 * badge when it does not fit below.
 */
export function placeJoinPopover(
  anchor: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  marginPx: number,
): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - panel.width / 2;
  const left = Math.max(
    marginPx,
    Math.min(centred, viewport.width - marginPx - panel.width),
  );
  const below = anchor.bottom + marginPx;
  const top =
    below + panel.height <= viewport.height - marginPx
      ? below
      : Math.max(marginPx, anchor.top - marginPx - panel.height);
  return { left, top };
}
