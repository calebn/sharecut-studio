export const SPLIT_OVERLAY_WIDTH_PX = 2;
export const SPAN_OVERLAY_MIN_WIDTH_PX = 3;

export function pendingOverlayWidthPx(
  type: string,
  spanWidthPx: number,
): number {
  if (type === "split") {
    return SPLIT_OVERLAY_WIDTH_PX;
  }
  return Math.max(SPAN_OVERLAY_MIN_WIDTH_PX, spanWidthPx);
}
