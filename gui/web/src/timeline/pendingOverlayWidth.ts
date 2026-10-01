export const SPLIT_OVERLAY_WIDTH_PX = 2;

export function pendingOverlayWidthPx(
  type: string,
  spanWidthPx: number,
): number {
  if (type === "split") {
    return SPLIT_OVERLAY_WIDTH_PX;
  }
  return Math.max(0, spanWidthPx);
}
