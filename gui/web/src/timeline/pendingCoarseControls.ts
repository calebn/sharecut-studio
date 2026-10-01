export type PendingCoarseHandleCenters = {
  start: number;
  end: number;
};

export function canShowPendingCoarseHandles(
  regionWidthPx: number,
  overlayHeightPx: number,
  targetSizePx: number,
): boolean {
  return regionWidthPx >= targetSizePx && overlayHeightPx >= targetSizePx * 2;
}

export function pendingCoarseHandleCenters(
  startPx: number,
  endPx: number,
  canvasWidthPx: number,
  targetSizePx: number,
): PendingCoarseHandleCenters | null {
  const halfTarget = targetSizePx / 2;
  if (
    endPx - startPx < targetSizePx ||
    startPx < 0 ||
    endPx > canvasWidthPx ||
    canvasWidthPx < targetSizePx
  ) {
    return null;
  }
  return { start: startPx + halfTarget, end: endPx - halfTarget };
}
